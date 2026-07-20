package com.sentum.controller;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.pojo.AssociationalWord;
import com.sentum.pojo.DrugAndIndicationIndex;
import com.sentum.pojo.DrugInfo;
import com.sentum.pojo.vo.DataResult;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.IndexOperations;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@RestController
@Slf4j
@RequestMapping("/brush")
public class BrushController {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }
    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    RedisTemplate redisTemplate;




    private JSONArray getJsonList(Object jsonObject){

        if (ObjectUtils.isEmpty(jsonObject)) {
            return null;
        }

        //json转为jsonarray
        JSONArray objects = new JSONArray();
        try {
            objects = JSONArray.parseArray(JSONObject.toJSONString(jsonObject));
        }catch (Exception e){
            e.printStackTrace();
            return objects;

        }

        if (objects.size()<=0){
            return objects;
        }

        // 假设 objects 是 JSONArray 类型
        objects.removeIf(obj -> obj instanceof JSONObject && "img".equals(((JSONObject) obj).getString("tag")));

        return objects;

    }

    @GetMapping("/addInstructions")
    public void instructions_byId() {
        String table = "instructions_nmpa";
        String tableName = "instructions_nmpa_use_4";
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));

        long total = dataMongoTemplate.count(new Query(), table);
        long page = (total / 1000) + 1;

        for (int i = 0; i < page; i++) {
            List<JSONObject> docs = dataMongoTemplate.find(new Query().skip(i * 1000).limit(1000), JSONObject.class, table);

            List<JSONObject> toInsertToTable = new ArrayList<>();
            List<JSONObject> toInsertToMini = new ArrayList<>();

            for (JSONObject doc : docs) {
                // 字段重命名处理
                if (doc.containsKey("approveCodeNMPA")) {
                    doc.put("approveCode", doc.get("approveCodeNMPA"));
                }


                // // JSON 数组字段清洗
                // for (String key : doc.keySet()) {
                //     if (doc.get(key) instanceof List) {
                //         doc.put(key, getJsonList(doc.get(key)));
                //     }
                // }

                // 构建 mini 数据对象
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("_id", doc.get("_id"));
                jsonObject.put("approveCode", doc.get("approveCode"));
                jsonObject.put("indication", getJsonList(doc.get("indication")));
                jsonObject.put("pdf", doc.get("pdf"));

                // doc = filterNestedJson(doc);


                toInsertToTable.add(doc);
                toInsertToMini.add(jsonObject);
            }

            // 批量插入主表
            batchInsert(dataMongoTemplatex, toInsertToTable, tableName);

            // 批量插入 mini 表
            batchInsert(dataMongoTemplatex, toInsertToMini, "instructions_mini_4");

            System.out.println("加载了条数：" + (i + 1) * 1000);
        }

        System.out.println("加载完成");
    }

    private void batchInsert(MongoTemplate template, List<JSONObject> list, String collectionName) {
        if (list.isEmpty()) return;

        int batchSize = 100; // 每批插入数量，可调优
        int size = list.size();

        for (int start = 0; start < size; start += batchSize) {
            int end = Math.min(start + batchSize, size);
            List<JSONObject> subList = list.subList(start, end);

            try {
                template.insert(subList, collectionName);
                log.info("批量插入成功，数量：{}", subList.size());
            } catch (Exception e) {
                log.error("批量插入失败，尝试逐条插入，collection: {}", collectionName, e);
                // 逐条插入失败数据
                for (JSONObject obj : subList) {
                    try {
                        template.insert(obj, collectionName);
                    } catch (Exception ex) {
                        log.error("单条插入失败，记录: {}", obj.getString("_id"), ex);
                    }
                }
            }
        }
    }


    @GetMapping("/addMongo/{table}")
    public void instructions_cleaning(@PathVariable("table") String table, String tableName, Integer x, Boolean haveEs) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
        long page = (instructionsCleaning - x) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 + x).limit(1000), JSONObject.class, table);
            for (JSONObject doc : instructionsCleaning1) {

                if (doc.containsKey("approveCodeNMPA")) {
                    doc.put("approveCode", doc.get("approveCodeNMPA"));
                    doc.remove("approveCodeNMPA");
                }
                if (doc.containsKey("warningsMarks")) {
                    doc.put("drugWarning", doc.get("warningsMarks"));
                    doc.remove("warningsMarks");
                }


                //摘出来一部分数据
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("_id", doc.get("_id"));
                jsonObject.put("approveCode", doc.get("approveCode"));
                JSONObject indication = doc.getJSONObject("indication");
                if (ObjectUtil.isEmpty(indication)) {
                    indication = indication.getJSONObject("effectsAndIndications");
                }
                jsonObject.put("indication", indication);

                jsonObject.put("pdf", doc.get("pdf"));


                try {
                    dataMongoTemplatex.insert(doc, tableName);
                    dataMongoTemplatex.insert(jsonObject, "instructions_mini");
                } catch (Exception e) {
                    log.error(doc.toString());
                }

            }

            System.out.println("加载了条数：" + (i + 1) * 1000);
        }
        System.out.println("加载完成");
    }



    @GetMapping("/addMongoById/{approveCode}")
    public void instructions_byId(@PathVariable("approveCode") String approveCode,String  table, String tableName, Integer x, Boolean haveEs) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));


            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query(Criteria.where("approveCodeNMPA").is(approveCode)), JSONObject.class, table);
            for (JSONObject doc : instructionsCleaning1) {

                if (doc.containsKey("approveCodeNMPA")) {
                    doc.put("approveCode", doc.get("approveCodeNMPA"));
                    doc.remove("approveCodeNMPA");
                }
                if (doc.containsKey("warningsMarks")) {
                    doc.put("drugWarning", doc.get("warningsMarks"));
                    doc.remove("warningsMarks");
                }


                //摘出来一部分数据
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("_id", doc.get("_id"));
                jsonObject.put("approveCode", doc.get("approveCode"));
                jsonObject.put("indication", doc.get("indication"));
                jsonObject.put("pdf", doc.get("pdf"));


                try {

                    dataMongoTemplatex.remove(new Query(Criteria.where("approveCode").is(approveCode)), tableName);
                    dataMongoTemplatex.remove(new Query(Criteria.where("approveCode").is(approveCode)), "instructions_mini");

                    dataMongoTemplatex.insert(doc, tableName);
                    dataMongoTemplatex.insert(jsonObject, "instructions_mini");
                } catch (Exception e) {
                    log.error(doc.toString());
                }

            }



    }




    @GetMapping("/all-drug/{table}")
    public String allDrugs(@PathVariable("table") String table, Integer x) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_PHARMACY_DATA")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
        long page = (instructionsCleaning - x) / 1000 + 1;
        HashSet<String> strings = new HashSet<>();
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 + x).limit(1000), JSONObject.class, table);
            //mongo
            List<DrugInfo> drugInfos = new ArrayList<>();
            //es
            List<DrugAndIndicationIndex> indexList = new ArrayList<>();
            for (JSONObject doc : instructionsCleaning1) {
                DrugInfo drugInfo = new DrugInfo();
                DrugAndIndicationIndex index = new DrugAndIndicationIndex();
                drugInfos.add(drugInfo);
                indexList.add(index);
                List<String> symbolList = Arrays.asList("-", "--", "---", "----", "-----", "------", "－－－－", "—", "——", "————", "/");

                //药品查询名单
                ArrayList<String> drugNames = new ArrayList<>();
                ArrayList<String> zhDrugNames = new ArrayList<>();
                ArrayList<String> enDrugNames = new ArrayList<>();


                drugInfo.setId(doc.getString("_id"));
                index.setId(drugInfo.getId());


                //产品名称
                String drugName = doc.getString("product_name");
                if (StrUtil.isEmpty(drugName)) {
                    continue;
                }
                drugInfo.setDrugName(drugName);
                index.setZhDrugName(drugName);
                drugNames.add(drugName.toLowerCase());

                //英文名称
                String drugNameEn = doc.getString("english_name");
                if (StrUtil.isEmpty(drugNameEn)) {
                    drugNameEn = "";
                }

                drugNames.add(drugNameEn.toLowerCase());
                //注册证号
                String register = doc.getString("registration_certificate_number");
                if (StrUtil.isEmpty(register)) {
                    register = "";
                }
                drugInfo.setRegister(register);
                index.setRegister(register);

                //中文商品名称
                String communityNameZh = doc.getString("product_name_chinese");
                if (StrUtil.isEmpty(communityNameZh)) {
                    communityNameZh = "";
                }
                drugNames.add(communityNameZh.toLowerCase());
                drugInfo.setCommunityNameZh(communityNameZh);
                index.setCommodityNameZh(communityNameZh);

                //英文商品名称
                String communityNameEn = doc.getString("product_name_english");
                if (StrUtil.isEmpty(communityNameEn)) {
                    communityNameEn = "";
                }
                drugInfo.setCommunityNameEn(communityNameEn);
                index.setCommodityNameEn(communityNameEn);
                drugNames.add(communityNameEn.toLowerCase());

                //剂型
                String dosageForm = doc.getString("dosage_form");
                if (StrUtil.isNotBlank(dosageForm)) {
                    if (CollUtil.contains(symbolList, dosageForm)) {
                        dosageForm = "";
                    }
                }
                drugInfo.setDosageForm(dosageForm);
                index.setDosageForm(dosageForm);
                //规格
                String specifications = doc.getString("specifications");
                if (StrUtil.isBlank(specifications)) {
                    specifications = "";
                }
                if (CollUtil.contains(symbolList, specifications)) {
                    specifications = "";
                }
                drugInfo.setSpecifications(specifications);
                index.setSpecifications(specifications);
                //厂商
                String manufacturer = getAuthorizationHolder(doc);
                drugInfo.setManufacturer(manufacturer);
                index.setManufacturer(manufacturer);
                //中成药还是西药
                String drugCategory = doc.getString("drug_type");
                if (StrUtil.isBlank(drugCategory)) {
                    drugCategory = "";
                }
                drugInfo.setDrugCategory(drugCategory);
                index.setDrugCategory(drugCategory);
                //五级中文
                String drugZh = doc.getString("level_5_chinese");
                if (StrUtil.isBlank(drugZh)) {
                    drugZh = "";
                }
                drugInfo.setDrugZh(drugZh);
                index.setDrugZh(drugZh);
                drugNames.add(drugZh.toLowerCase());
                zhDrugNames.add(drugZh);
                //五级英文
                String drugEn = doc.getString("level_5_english");
                if (StrUtil.isBlank(drugEn)) {
                    drugEn = "";
                }
                drugInfo.setDrugEn(drugEn);
                index.setDrugEn(drugEn);
                drugNames.add(drugEn.toLowerCase());
                enDrugNames.add(drugEn.toLowerCase());
                //五级中文同义词
                List<String> drugSynonymZh = new ArrayList<>();
                String string = doc.getString("level_5_chinese_synonyms");
                if (StrUtil.isNotBlank(string)) {
                    String[] split = string.split("卍");
                    drugSynonymZh.addAll(Arrays.asList(split));
                }
                drugInfo.setDrugSynonymZh(drugSynonymZh);
                List<String> drugSynonymZhLowercase = drugSynonymZh.stream()
                        .map(String::toLowerCase)
                        .collect(Collectors.toList());

                drugNames.addAll(drugSynonymZhLowercase);
                zhDrugNames.addAll(drugSynonymZhLowercase);
                //五级英文同义词
                List<String> drugSynonymEn = new ArrayList<>();
                String drugEn2 = doc.getString("level_5_english_synonyms");
                if (StrUtil.isNotBlank(drugEn2)) {
                    String[] split = drugEn2.split("卍");
                    drugSynonymEn.addAll(Arrays.asList(split));
                }
                drugInfo.setDrugSynonymEn(drugSynonymEn);
                List<String> drugSynonymEnLowercase = drugSynonymEn.stream()
                        .map(String::toLowerCase)
                        .collect(Collectors.toList());
                drugNames.addAll(drugSynonymEnLowercase);
                enDrugNames.addAll(drugSynonymEnLowercase);

                //适应症清单（疾病名称）
                List<String> disease = new ArrayList<>();

                //中文疾病名称
                List<String> diseaseZh = new ArrayList<>();
                String indicationZh = doc.getString("indications");
                if (StrUtil.isNotBlank(indicationZh)) {
                    String[] split = indicationZh.split("###");
                    for (String txt : split) {
                        if (!"-".equals(txt)) {
                            diseaseZh.add(txt);
                        }
                    }
                }
                drugInfo.setDiseaseZh(diseaseZh);
                index.setDiseaseZh(diseaseZh);
                index.setDisease(diseaseZh);
                //医保类型
                String medicalInsurance = doc.getString("medical_insurance_type");
                if (StrUtil.isBlank(medicalInsurance)) {
                    medicalInsurance = "";
                }
                drugInfo.setMedicalInsurance(medicalInsurance);
                index.setMedicalInsurance(medicalInsurance);
                //是否是基药
                String essentialMedicines = doc.getString("base_drug_flag");
                if (StrUtil.isBlank(essentialMedicines)) {
                    essentialMedicines = "";
                }
                drugInfo.setEssentialMedicines(essentialMedicines);
                //是否有requirement_for_△_flag要求
                String essentialType = doc.getString("requirement_for_△_flag");
                if (StrUtil.isBlank(essentialType)) {
                    essentialType = "";
                }
                drugInfo.setEssentialType(essentialType);
                //支付限制

                String paymentScope = doc.getString("payment_limits");
                if (StrUtil.isBlank(paymentScope)) {
                    paymentScope = "";
                }
                drugInfo.setPaymentScope(paymentScope);

                //是否需要皮试
                String skinTest = doc.getString("skin_test_flag");
                if (StrUtil.isBlank(skinTest)) {
                    skinTest = "";
                }
                drugInfo.setSkinTest(skinTest);
                //是否集采药品
                String drugCollection = doc.getString("centralized_procurement_of_drugs_flag");
                if (StrUtil.isBlank(drugCollection)) {
                    drugCollection = "";
                }
                drugInfo.setDrugCollection(drugCollection);
                //是否仿制参比药品
                String referenceDrug = doc.getString("reference_drug_for_generic_drugs_flag");
                if (StrUtil.isBlank(referenceDrug)) {
                    referenceDrug = "";
                }
                drugInfo.setReferenceDrug(referenceDrug);
                //是否原研药品
                String originalDrug = doc.getString("original_research_drug_flag");
                if (StrUtil.isBlank(originalDrug)) {
                    originalDrug = "";
                }
                drugInfo.setOriginalDrug(originalDrug);
                //是否一致性评价药品
                String consistencyDrug = doc.getString("consistency_evaluation_of_drugs_flag");
                if (StrUtil.isBlank(consistencyDrug)) {
                    consistencyDrug = "";
                }
                drugInfo.setConsistencyDrug(consistencyDrug);

                //复方
                String ingredient = doc.getString("unilateral_or_compound_preparations");
                if (StrUtil.isBlank(ingredient)) {
                    ingredient = "";
                }
                drugInfo.setDrugType(ingredient);

                //中成药保护品种
                String protectionLevel = doc.getString("protection_level");
                String isProtected = "是";
                if (StrUtil.isBlank(protectionLevel)) {
                    isProtected = "";
                }
                drugInfo.setIsProtected(isProtected);


                if (StrUtil.isBlank(protectionLevel)) {
                    protectionLevel = "";
                }
                drugInfo.setProtectionLevel(protectionLevel);

                String string1 = doc.getString("scope_of_protection_period");
                if (StrUtil.isBlank(string1)) {
                    string1 = "";
                }
                drugInfo.setProtectionPeriod(string1);

                String oneNameZh = doc.getString("level_1_chinese");
                if (StrUtil.isBlank(oneNameZh)) {
                    oneNameZh = "";
                }
                drugInfo.setOneNameZh(oneNameZh);

                String oneNameEn = doc.getString("level_1_english");
                if (StrUtil.isBlank(oneNameEn)) {
                    oneNameEn = "";
                }
                drugInfo.setOneNameEn(oneNameEn);

                String twoNameZh = doc.getString("level_2_chinese");
                if (StrUtil.isBlank(twoNameZh)) {
                    twoNameZh = "";
                }
                drugInfo.setTwoNameZh(twoNameZh);

                String twoNameEn = doc.getString("level_2_english");
                if (StrUtil.isBlank(twoNameEn)) {
                    twoNameEn = "";
                }
                drugInfo.setTwoNameEn(twoNameEn);

                String threeNameZh = doc.getString("level_3_chinese");
                if (StrUtil.isBlank(threeNameZh)) {
                    threeNameZh = "";
                }
                drugInfo.setThreeNameZh(threeNameZh);

                String threeNameEn = doc.getString("level_3_english");
                if (StrUtil.isBlank(threeNameEn)) {
                    threeNameEn = "";
                }
                drugInfo.setThreeNameEn(threeNameEn);

                String fourNameZh = doc.getString("level_4_chinese");
                if (StrUtil.isBlank(fourNameZh)) {
                    fourNameZh = "";
                }
                drugInfo.setFourNameZh(fourNameZh);

                String fourNameEn = doc.getString("level_4_english");
                if (StrUtil.isBlank(fourNameEn)) {
                    fourNameEn = "";
                }
                drugInfo.setFourNameEn(fourNameEn);

                //五级编码
                String fiveCoding = doc.getString("level_5_code");
                if (StrUtil.isBlank(fiveCoding)) {
                    fiveCoding = "";
                }
                drugInfo.setFiveCoding(fiveCoding);

                //otc
                String otc = doc.getString("otc");
                if (StrUtil.isBlank(otc)) {
                    otc = "";
                }
                drugInfo.setOtc(otc);

                //是否收录药典
                String isInclude = doc.getString("recorded_in_pharmacopoeia_part_1");
                if (StrUtil.isBlank(isInclude)) {
                    isInclude = "";
                }
                drugInfo.setIsInclude(isInclude);

                index.setDrugType(drugInfo.getDrugType());

                //es查询字段
                drugNames.remove("");
                index.setZhDrugNames(zhDrugNames);
                index.setEnDrugNames(enDrugNames);
                index.setDrugName(drugNames);
                strings.addAll(drugNames);

            }
            try {
                mongoTemplate.insert(drugInfos, DrugInfo.class);
                elasticsearchRestTemplate.save(indexList);
            } catch (Exception e) {
                e.printStackTrace();
            }

            System.out.println("加载了条数：" + (i + 1) * 1000);
        }
        log.info("数量1:{}",strings.size());

//         IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AssociationalWord.class);
//        // 创建索引
//        boolean indexResult = indexOperations.create();
//        // 定义mapping关系
//        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AssociationalWord.class));
//
//        List<AssociationalWord> list = new ArrayList<>();
//        for (String string : strings) {
//            list.add(new AssociationalWord(UUID.randomUUID().toString(), string.toLowerCase(), string.length()));
//        }
//        elasticsearchRestTemplate.save(list);
//
//        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(), JSONObject.class, "evidence_icd11");
//        HashSet<String> strings1 = new HashSet<>();
//        for (JSONObject jsonObject : jsonObjects) {
//            strings1.add(jsonObject.getString("chinese_name"));
//        }
//        log.info("数量2:{}",strings1.size());
//         List<AssociationalWord> list1 = new ArrayList<>();
//        for (String string : strings1) {
//            list1.add(new AssociationalWord(UUID.randomUUID().toString(), string.toLowerCase(), string.length()));
//        }
//        elasticsearchRestTemplate.save(list1);
//        System.out.println("加载完成");


        return "1";

    }


    private String getAuthorizationHolder(JSONObject doc) {
        List<String> symbolList = Arrays.asList("-", "--", "---", "----", "-----", "------", "－－－－", "—", "——", "————", "/");
        String listingAuthorizationHolderChinese = doc.getString("listing_authorization_holder_chinese");
        if (StrUtil.isNotBlank(listingAuthorizationHolderChinese) && !symbolList.contains(listingAuthorizationHolderChinese)) {
            return listingAuthorizationHolderChinese;
        }

        String listingAuthorizationHolderEnglish = doc.getString("listing_authorization_holder_english");
        if (StrUtil.isNotBlank(listingAuthorizationHolderEnglish) && !symbolList.contains(listingAuthorizationHolderEnglish)) {
            return listingAuthorizationHolderEnglish;
        }

        String companyNameChinese = doc.getString("company_name_chinese");
        if (StrUtil.isNotBlank(companyNameChinese) && !symbolList.contains(companyNameChinese)) {
            return companyNameChinese;
        }
        String companyNameEnglish = doc.getString("company_name_english");
        if (StrUtil.isNotBlank(companyNameEnglish) && !symbolList.contains(companyNameEnglish)) {
            return companyNameEnglish;
        }

        return ""; // 默认值或处理情况
    }

    @GetMapping("/vae")
    public DataResult vae() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), "mergedCollection");
        long page = (instructionsCleaning) / 1000 - 10822;
        for (int i = 0; i < page; i++) {
            JSONArray jsonArray11 = new JSONArray();
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip((i + 10823) * 1000).limit(1000), JSONObject.class, "mergedCollection");
            for (JSONObject jsonObject : instructionsCleaning1) {
                JSONArray jsonArray = jsonObject.getJSONArray("role_cod");
                JSONArray jsonArray1 = jsonObject.getJSONArray("drugname");
                JSONArray jsonArray2 = jsonObject.getJSONArray("prod_ai");
                ArrayList<String> strings1 = new ArrayList<>();
                ArrayList<String> strings2 = new ArrayList<>();
                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                    String role = jsonArray.getString(i1);
                    if (StrUtil.isNotBlank(role) && "PS".equals(role)) {
                        strings1.add(jsonArray1.getString(i1));
                        strings2.add(jsonArray2.getString(i1));
                    }
                }
                jsonObject.put("psDrugname", strings1);
                jsonObject.put("psProd_ai", strings2);
                jsonArray11.add(jsonObject);

            }

            insertWithRetry(jsonArray11, dataMongoTemplate);
        }
        return DataResult.ok();
    }

    public void insertWithRetry(JSONArray jsonArray11, MongoTemplate dataMongoTemplate) {
        int maxAttempts = 3;
        int attempts = 0;
        while (attempts < maxAttempts) {
            try {
                dataMongoTemplate.insert(jsonArray11, "mergedCollectionPs");
                break; // 成功后退出循环
            } catch (Exception e) {
                attempts++;
                if (attempts >= maxAttempts) {
                    throw new RuntimeException("Failed to insert after " + maxAttempts + " attempts", e);
                }
                try {
                    Thread.sleep(1000); // 等待1秒后重试
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("Thread interrupted", ie);
                }
            }
        }
    }





    @GetMapping("/filter_x")
    public DataResult filterX() {
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(), JSONObject.class, "Sheet1");
        HashSet<String> strings = new HashSet<>();
        for (JSONObject jsonObject : jsonObjects) {
            JSONObject jsonObject1 = new JSONObject();
            String string1 = jsonObject.getString("一级分类");
            String string2 = jsonObject.getString("二级分类");
            String string3 = jsonObject.getString("三级分类");
            String string4 = jsonObject.getString("四级分类");
            if (!strings.contains(string1 + jsonObject.get("药品类别"))) {
                strings.add(string1 + jsonObject.get("药品类别"));
                jsonObject1.put("parentId", "0");
                jsonObject1.put("name", string1);
                jsonObject1.put("level", "1");
                jsonObject1.put("type", jsonObject.get("药品类别"));
                jsonObject1.put("sort", "");
                mongoTemplate.save(jsonObject1, "drug_category_simple2");
            }
        }

        for (JSONObject jsonObject : jsonObjects) {
            JSONObject jsonObject1 = new JSONObject();
            String string1 = jsonObject.getString("一级分类");
            String string2 = jsonObject.getString("二级分类");
            String string3 = jsonObject.getString("三级分类");
            String string4 = jsonObject.getString("四级分类");
            if (StrUtil.isNotEmpty(string2) && !strings.contains(string1 + string2 + jsonObject.get("药品类别"))) {
                strings.add(string1 + string2 + jsonObject.get("药品类别"));
                List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("level").is("1").and("name").is(string1).and("type").is(jsonObject.get("药品类别"))), JSONObject.class, "drug_category_simple2");
                String o = jsonObjects1.get(0).getString("_id");
                jsonObject1.put("parentId", o);
                jsonObject1.put("name", string2);
                jsonObject1.put("level", "2");
                jsonObject1.put("type", jsonObject.get("药品类别"));
                mongoTemplate.save(jsonObject1, "drug_category_simple2");

            }
        }

        for (JSONObject jsonObject : jsonObjects) {
            JSONObject jsonObject1 = new JSONObject();
            String string1 = jsonObject.getString("一级分类");
            String string2 = jsonObject.getString("二级分类");
            String string3 = jsonObject.getString("三级分类");
            String string4 = jsonObject.getString("四级分类");
            if (StrUtil.isNotEmpty(string3) && !strings.contains(string1 + string2 + string3 + jsonObject.get("药品类别"))) {
                strings.add(string1 + string2 + string3 + jsonObject.get("药品类别"));
                List<JSONObject> jsonObjectsx = mongoTemplate.find(new Query(Criteria.where("level").is("2").and("name").is(string2).and("type").is(jsonObject.get("药品类别"))), JSONObject.class, "drug_category_simple2");
                if (jsonObjectsx.size() > 1) {
                    for (JSONObject jsonObject2 : jsonObjectsx) {
                        String string = jsonObject2.getString("parentId");
                        List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("_id").is(string)), JSONObject.class, "drug_category_simple2");
                        if (string1.equals(jsonObjects1.get(0).getString("name"))) {
                            String o1 = jsonObject2.getString("_id");
                            jsonObject1.put("parentId", o1);
                        }
                    }
                } else {
                    String o1 = jsonObjectsx.get(0).getString("_id");
                    jsonObject1.put("parentId", o1);

                }
                jsonObject1.put("name", string3);
                jsonObject1.put("level", "3");
                jsonObject1.put("type", jsonObject.get("药品类别"));
                mongoTemplate.save(jsonObject1, "drug_category_simple2");
            }
        }
        for (JSONObject jsonObject : jsonObjects) {
            JSONObject jsonObject1 = new JSONObject();
            String string1 = jsonObject.getString("一级分类");
            String string2 = jsonObject.getString("二级分类");
            String string3 = jsonObject.getString("三级分类");
            String string4 = jsonObject.getString("四级分类");
            String string5 = jsonObject.getString("五级名称");
            if (StrUtil.isNotEmpty(string4) && !strings.contains(string1 + string2 + string3 + string4 + jsonObject.get("药品类别"))) {
                strings.add(string1 + string2 + string3 + string4 + jsonObject.get("药品类别"));
                List<JSONObject> jsonObjectsx = mongoTemplate.find(new Query(Criteria.where("level").is("3").and("name").is(string3).and("type").is(jsonObject.get("药品类别"))), JSONObject.class, "drug_category_simple2");
                if (jsonObjectsx.size() > 1) {
                    for (JSONObject jsonObject2 : jsonObjectsx) {
                        String string = jsonObject2.getString("parentId");
                        List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("_id").is(string)), JSONObject.class, "drug_category_simple2");
                        if (string2.equals(jsonObjects1.get(0).getString("name"))) {
                            String o1 = jsonObject2.getString("_id");
                            jsonObject1.put("parentId", o1);
                        }
                    }
                } else {
                    String o1 = jsonObjectsx.get(0).getString("_id");
                    jsonObject1.put("parentId", o1);
                }
                jsonObject1.put("name", string4);
                jsonObject1.put("level", "4");
                jsonObject1.put("type", jsonObject.get("药品类别"));
                mongoTemplate.insert(jsonObject1, "drug_category_simple2");
            }



            }

        ArrayList<String> strings1 = new ArrayList<>();
        for (JSONObject jsonObject : jsonObjects) {
            JSONObject jsonObject1 = new JSONObject();
            String string1 = jsonObject.getString("一级分类");
            String string2 = jsonObject.getString("二级分类");
            String string3 = jsonObject.getString("三级分类");
            String string4 = jsonObject.getString("四级分类");
            String string5 = jsonObject.getString("五级名称");
            Criteria criteria = new Criteria();

            String name2 = "";
            if (StringUtils.isNotEmpty(string4)){
                criteria.and("name").is(string4);
                criteria.and("level").is("4");
                criteria.and("type").is(jsonObject.get("药品类别"));
                name2 = string3;

            }else if (StringUtils.isNotEmpty(string3)){
                criteria.and("name").is(string3);
                criteria.and("level").is("3");
                criteria.and("type").is(jsonObject.get("药品类别"));
                name2 = string2;
            }else if (StringUtils.isNotEmpty(string2)){
                criteria.and("name").is(string2);
                criteria.and("level").is("2");
                criteria.and("type").is(jsonObject.get("药品类别"));
                name2 = string1;
            }else if (StringUtils.isNotEmpty(string1)){
                criteria.and("name").is(string1);
                criteria.and("level").is("1");
                criteria.and("type").is(jsonObject.get("药品类别"));
            }


                List<JSONObject> jsonObjectsx = mongoTemplate.find(new Query(criteria), JSONObject.class, "drug_category_simple2");
                if (jsonObjectsx.size() > 1) {
                    for (JSONObject jsonObject2 : jsonObjectsx) {
                        String string = jsonObject2.getString("parentId");
                        List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("_id").is(string)), JSONObject.class, "drug_category_simple2");
                        if (name2.equals(jsonObjects1.get(0).getString("name"))) {
                            String o1 = jsonObject2.getString("_id");
                            jsonObject1.put("parentId", o1);
                        }
                    }
                } else {
                    String o1 = jsonObjectsx.get(0).getString("_id");
                    jsonObject1.put("parentId", o1);
                }

            String string = jsonObject1.getString("parentId");
                if (strings1.contains(string+string5)){
                    continue;
                }else {
                    strings1.add(string+string5);
                }
            jsonObject1.put("name", string5);
                jsonObject1.put("level", "5");
                jsonObject1.put("type", jsonObject.get("药品类别"));
                mongoTemplate.insert(jsonObject1, "drug_category_simple2");
            }
        return DataResult.ok();
        }

        @GetMapping("/drugx")
        public HashSet<String> Drugs () {

            long instructionsCleaning = mongoTemplate.count(new Query(Criteria.where("drugCategory").is("西药")), "evaluation_drug_info_v2");
            long page = (instructionsCleaning) / 1000 + 1;
            HashSet<String> strings = new HashSet<>();
            for (int i = 0; i < page; i++) {
                List<JSONObject> instructionsCleaning1 = mongoTemplate.find(new Query(Criteria.where("drugCategory").is("西药")).skip(i * 1000).limit(1000), JSONObject.class, "evaluation_drug_info_v2");
                for (JSONObject jsonObject1 : instructionsCleaning1) {
                    String string = jsonObject1.getString("drugZh");
                    strings.add(string);
                }
                System.out.println("加载了条数：" + (i + 1) * 1000);
            }
//        for (String string : strings) {
//            mongoTemplate.save(string, "drug_zh_all");
//        }
            ArrayList<String> strings1 = new ArrayList<>(strings);
            redisTemplate.opsForValue().set("drugZhAll", strings1);

            return strings;
        }


    }








