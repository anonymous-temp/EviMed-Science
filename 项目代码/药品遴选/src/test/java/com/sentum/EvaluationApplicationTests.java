package com.sentum;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpUtil;
import cn.hutool.poi.excel.ExcelReader;
import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.ExcelWriter;
import com.alibaba.excel.write.handler.AbstractRowWriteHandler;
import com.alibaba.excel.write.metadata.WriteSheet;
import com.alibaba.excel.write.metadata.holder.WriteSheetHolder;
import com.alibaba.excel.write.metadata.holder.WriteTableHolder;
import com.alibaba.excel.write.metadata.style.WriteCellStyle;
import com.alibaba.excel.write.metadata.style.WriteFont;
import com.alibaba.excel.write.style.HorizontalCellStyleStrategy;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.MongoClients;
import com.sentum.controller.StreamApiController;
import com.sentum.excel.bean.MedicineEvaluation;
import com.sentum.feign.EvidenceFeign;
import com.sentum.pojo.*;
import com.sentum.service.LxGptService;
import com.sentum.service.impl.LxGptServiceImpl;
import com.sentum.util.GptCallUtil;
import com.sentum.util.GptUtil;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.poi.ss.usermodel.*;
import org.junit.jupiter.api.Test;
import org.junit.platform.commons.util.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.IndexOperations;
import org.springframework.data.elasticsearch.core.document.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import java.io.*;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@SpringBootTest
@Slf4j
class EvaluationApplicationTests {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        org.junit.jupiter.api.Assumptions.assumeTrue(
                value != null && !value.trim().isEmpty(),
                name + " is required for this external MongoDB integration test"
        );
        return value.trim();
    }

    @Autowired
    LxGptService lxGptSercvice;

    @Autowired
    MongoTemplate mongoTemplate;
    
    @Autowired
    LxGptServiceImpl lxGptService;

    @Autowired
    EvidenceFeign evidenceFeign;


    @Autowired
    GptUtil gptUtil;

    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    GptCallUtil gptCallUtil;

    @Autowired
    StreamApiController streamApiController;


    @Test
    public void excel(){


        try {
            // 本地保存路径（空着，可根据需要修改）
            String localDir = "C:/Users/Administrator/Desktop/53个药品excel"; // 这里是本地目录，例如："D:/药品数据导出/"

            // 确保目录存在
            if (!localDir.isEmpty()) {
                File dir = new File(localDir);
                if (!dir.exists()) {
                    dir.mkdirs();
                }
            }

            // 文件名处理

            String fileName = "中成药药品遴选评分细则.xlsx";

            List<MedicineEvaluation> drugEvaluationExcel = mongoTemplate.findAll(MedicineEvaluation.class, "drug_evaluation_excel_10");

            // 完整文件路径
            String filePath = localDir.isEmpty() ? fileName : localDir + File.separator + fileName;

            // 创建样式策略
            HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();

            // 写入本地文件
            try (ExcelWriter writer = EasyExcel.write(filePath, MedicineEvaluation.class)
                    .registerWriteHandler(styleStrategy)
                    .registerWriteHandler(new CustomRowHeightHandler())
                    .build()) {
                WriteSheet sheet = EasyExcel.writerSheet("中成药评价数据").build();
                writer.write(drugEvaluationExcel, sheet);
            }

            System.out.println("文件已成功导出到: " + new File(filePath).getAbsolutePath());

        } catch (Exception e) {
            e.printStackTrace();
            System.err.println("导出失败: " + e.getMessage());
        }
    }




    private static class CustomRowHeightHandler extends AbstractRowWriteHandler {
        @Override
        public void afterRowCreate(WriteSheetHolder writeSheetHolder, WriteTableHolder writeTableHolder, Row row, Integer relativeRowIndex, Boolean isHead) {
            Sheet sheet = writeSheetHolder.getSheet();

            if (isHead) {
                // 处理表头行高
                if (row.getRowNum() == 0 || row.getRowNum() == 1) {
                    // 第1、2行表头（较低行高）
                    row.setHeightInPoints(30);
                } else if (row.getRowNum() == 2) {
                    // 第3行表头（较高行高）
                    row.setHeightInPoints(30);
                }
            } else {
                // 处理数据行高（正文）
                row.setHeightInPoints(30); // 增加正文行高
            }
        }
    }

        private HorizontalCellStyleStrategy createCellStyleStrategy() {
            // 表头样式
            WriteCellStyle headStyle = new WriteCellStyle();
            WriteFont headFont = new WriteFont();
            headFont.setFontName("宋体");
            headFont.setFontHeightInPoints((short) 10);
            headFont.setBold(true);
            headStyle.setWriteFont(headFont);

            headStyle.setHorizontalAlignment(HorizontalAlignment.CENTER);
            headStyle.setVerticalAlignment(VerticalAlignment.CENTER);
            headStyle.setWrapped(true);
            headStyle.setFillPatternType(FillPatternType.NO_FILL);


            // 内容样式
            WriteCellStyle contentStyle = new WriteCellStyle();
            WriteFont contentFont = new WriteFont();
            contentFont.setFontName("宋体");
            contentFont.setFontHeightInPoints((short) 10);
            contentStyle.setWriteFont(contentFont);

            contentStyle.setHorizontalAlignment(HorizontalAlignment.CENTER);
            contentStyle.setVerticalAlignment(VerticalAlignment.CENTER);
            contentStyle.setWrapped(true);

            return new HorizontalCellStyleStrategy(headStyle, contentStyle);
        }


    @Test
    public void getInt(){
        List<String> drugApprovals = new ArrayList<>();

        // drugApprovals.add("国药准字Z20026439");
        // drugApprovals.add("国药准字Z20103032");
        // drugApprovals.add("国药准字Z12020589");
        // drugApprovals.add("国药准字Z20030096");
        // drugApprovals.add("国药准字Z53020136");
        // drugApprovals.add("国药准字Z44020284");
        // drugApprovals.add("国药准字Z20026866");
        // drugApprovals.add("国药准字Z53021569");
        // drugApprovals.add("国药准字Z20000022");
        // drugApprovals.add("国药准字Z10980058");
        // drugApprovals.add("国药准字Z11020385");
        // drugApprovals.add("国药准字Z20033237");
        // drugApprovals.add("国药准字Z20080280");
        // drugApprovals.add("国药准字Z20049007");
        // drugApprovals.add("国药准字Z44020045");
        // drugApprovals.add("国药准字Z20083065");
        // drugApprovals.add("国药准字Z10920027");
        // drugApprovals.add("国药准字Z53021547");
        // drugApprovals.add("国药准字Z20163112");
        // drugApprovals.add("国药准字Z10910036");
        // drugApprovals.add("国药准字Z44021186");
        // drugApprovals.add("国药准字Z61020168");
        // drugApprovals.add("国药准字Z20163050");
        // drugApprovals.add("国药准字Z34020284");
        // drugApprovals.add("国药准字Z10970036");
        // drugApprovals.add("国药准字Z20027144");
        // drugApprovals.add("国药准字Z20030017");
        // drugApprovals.add("国药准字Z10970056");
        // drugApprovals.add("国药准字Z12020223");
        // drugApprovals.add("国药准字Z19990040");
        // drugApprovals.add("国药准字Z20027411");
        drugApprovals.add("国药准字Z43020138");
        drugApprovals.add("国药准字Z20090035");
        drugApprovals.add("国药准字Z20080033");
        drugApprovals.add("国药准字Z10970026");
        drugApprovals.add("国药准字Z10950075");
        drugApprovals.add("国药准字Z20050845");
        drugApprovals.add("国药准字Z20020073");
        drugApprovals.add("国药准字Z19991011");
        drugApprovals.add("国药准字Z20010098");
        drugApprovals.add("国药准字Z20043267");
        drugApprovals.add("国药准字Z20025173");
        drugApprovals.add("国药准字Z51022475");
        drugApprovals.add("国药准字Z13020887");
        drugApprovals.add("国药准字Z13020889");
        drugApprovals.add("国药准字Z20060463");
        drugApprovals.add("国药准字Z10940034");
        drugApprovals.add("国药准字Z20090250");
        drugApprovals.add("国药准字Z20073256");
        drugApprovals.add("国药准字Z20030052");
        drugApprovals.add("国药准字Z13020772");
        drugApprovals.add("国药准字Z10960004");
        drugApprovals.add("国药准字Z20025660");


        ArrayList<String> strings = new ArrayList<>();
        ArrayList<String> strings1 = new ArrayList<>();


            for (String drugApproval : drugApprovals) {
                try {
                streamApiController.exportToLocal1(drugApproval);
                strings.add(drugApproval);
                log.info("成功导出{}",drugApproval);
            } catch (Exception e) {

                    log.error("错误信息：{}",    e.getMessage());
                    log.error("报错药品为:{}",drugApproval);
                    strings1.add(drugApproval);
            }
            }

            log.info("成功：{}",strings);
            log.info("失败：{}",strings1);

    }



    @Test
    public void splitDisease() {

        List<String> splitDisease = gptCallUtil.splitDisease("中度至重度活动性溃疡性结肠炎");
        System.out.println(splitDisease);
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



    @Test
    public void allDrugs() {
        int x = 0;
        String table = "drug_list_20250825";

        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_PHARMACY_DATA")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
        long page = (instructionsCleaning - x) / 1000 + 1;
        IndexOperations indexOperations1 = elasticsearchRestTemplate.indexOps(DrugAndIndicationIndex.class);
// 创建索引
        indexOperations1.create();
// 生成 mapping 并传入 putMapping 方法
        Document mapping = indexOperations1.createMapping(DrugAndIndicationIndex.class);
         indexOperations1.putMapping(mapping);
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
                String indicationZh = doc.getString("list_of_indications");
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

                //是否在国家基药协议期
                String isTheAgreementForTheJudgment = doc.getString("is_the_agreement_for_the_judgment");
                if (StrUtil.isBlank(isTheAgreementForTheJudgment)) {
                    isTheAgreementForTheJudgment = "";
                }
                drugInfo.setIsTheAgreementForTheJudgment(isTheAgreementForTheJudgment);

                //协议期时间段
                String protectionPeriod = doc.getString("term_of_agreement");
                if (StrUtil.isBlank(protectionPeriod)) {
                    protectionPeriod = "";
                }
                drugInfo.setTermOfAgreement(protectionPeriod);

                index.setDrugType(drugInfo.getDrugType());


                //数量
                String string2 = doc.getString("drug_specifications_and_quantity");
                if (StrUtil.isBlank(string2)) {
                    string2 = "";
                }
              drugInfo.setNumber(string2);

                //es查询字段
                drugNames.remove("");
                index.setZhDrugNames(zhDrugNames);
                index.setEnDrugNames(enDrugNames);
                index.setDrugName(drugNames);
                strings.addAll(drugNames);

            }

                // mongoTemplate.insert(drugInfos, DrugInfo.class);
                // elasticsearchRestTemplate.save(indexList);


            System.out.println("加载了条数：" + (i + 1) * 1000);
        }
        log.info("数量1:{}",strings.size());

        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AssociationalWord.class);
       // 创建索引
       boolean indexResult = indexOperations.create();
       // 定义mapping关系
       boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AssociationalWord.class));

       List<AssociationalWord> list = new ArrayList<>();
       for (String string : strings) {
           list.add(new AssociationalWord(UUID.randomUUID().toString(), string.toLowerCase(), string.length()));
       }
       // elasticsearchRestTemplate.save(list);

       List<JSONObject> jsonObjects = mongoTemplate.find(new Query(), JSONObject.class, "evidence_icd11");
       HashSet<String> strings1 = new HashSet<>();
       for (JSONObject jsonObject : jsonObjects) {
           strings1.add(jsonObject.getString("chinese_name"));
       }
       log.info("数量2:{}",strings1.size());
        List<AssociationalWord> list1 = new ArrayList<>();
       for (String string : strings1) {
           list1.add(new AssociationalWord(UUID.randomUUID().toString(), string.toLowerCase(), string.length()));
       }
       // elasticsearchRestTemplate.save(list1);
       System.out.println("加载完成");




    }


    public static boolean exportListToTxt(List<String> stringList, String filePath) {
        if (stringList == null || stringList.isEmpty()) {
            System.out.println("列表为空，无需导出");
            return false;
        }

        BufferedWriter writer = null;
        try {
            // 使用UTF-8编码创建文件写入流
            writer = new BufferedWriter(
                    new OutputStreamWriter(
                            new FileOutputStream(filePath),
                            StandardCharsets.UTF_8
                    )
            );

            // 遍历列表，每行写入一个元素
            for (String item : stringList) {
                // 确保处理null值
                String content = (item != null) ? item : "";
                writer.write(content);
                writer.newLine(); // 写入换行符
            }

            System.out.printf("成功导出 %d 项到 %s%n", stringList.size(), filePath);
            return true;
        } catch (Exception e) {
            System.err.println("导出失败: " + e.getMessage());
            e.printStackTrace();
            return false;
        } finally {
            // 确保资源关闭
            if (writer != null) {
                try {
                    writer.close();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
    }






    //gpt图片识别
    @Test
    public void gptImage() throws IOException {
        JSONObject jsonObject1 = new JSONObject();
        String prompt =
                "我要返回这种{\\\"disease_expanded_terms\\\": \" +\n" +
                        "                \"                   [{\" +\n" +
                        "                \"                      \\\"ch_term\\\":\\\"糖尿病\\\",\" +\n" +
                        "                \"                      \\\"en_term\\\":\\\"Diabetes Mellitus\\\",\" +\n" +
                        "                \"                      \\\"en_abbr\\\":\\\"DM\\\"\" +\n" +
                        "                \"                   },\\n \" +\n" +
                        "                \"                   {\" +\n" +
                        "                \"                      \\\"ch_term\\\":\\\"1型糖尿病\\\",\" +\n" +
                        "                \"                      \\\"en_term\\\":\\\"Type 1 Diabetes\\\",\" +\n" +
                        "                \"                      \\\"en_abbr\\\":\\\"T1DM\\\"\" +\n" +
                        "                \"                   },\\n \" +\n" +
                        "                \"                   {\" +\n" +
                        "                \"                      \\\"ch_term\\\":\\\"糖尿病并发症\\\",\" +\n" +
                        "                \"                      \\\"en_term\\\":\\\"Diabetic Complications\\\",\" +\n" +
                        "                \"                      \\\"en_abbr\\\":\\\"DC\\\"\" +\n" +
                        "                \"                   },\\n \" +\n" +
                        "                \"                   {\" +\n" +
                        "                \"                      \\\"ch_term\\\":\\\"糖耐量异常\\\",\" +\n" +
                        "                \"                      \\\"en_term\\\":\\\"Impaired Glucose Tolerance\\\",\" +\n" +
                        "                \"                      \\\"en_abbr\\\":\\\"IGT\\\"\" +\n" +
                        "                \"                   },\\n \" +\n" +
                        "                \"                   {\" +\n" +
                        "                \"                      \\\"ch_term\\\":\\\"糖尿病肾病\\\",\" +\n" +
                        "                \"                      \\\"en_term\\\":\\\"Diabetic Nephropathy\\\",\" +\n" +
                        "                \"                      \\\"en_abbr\\\":\\\"DN\\\"\" +\n" +
                        "                \"                   }]\\n}格式的返回值如何组装responseFormat" +
                "";
                jsonObject1.put("prompt", prompt);
        //["gpt-3.5-turbo","gpt-4-0613"]

        jsonObject1.put("model", "gpt-4o-mini");

        String generation = gptUtil.generation(jsonObject1);
        log.info(generation);
    }



    @Test
    void instructionEs() {

        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(InstructionsUseIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(InstructionsUseIndex.class));
        if (indexResult && mappingResult) {
            int pageSize = 1000;
            long count = dataMongoTemplate.count(new Query(), JSONObject.class, "instructions_nmpa");
            log.info("-----开始更新用药助手说明书数据共[{}]-----", count);
            int pages = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);

            Set<String> approveCodeSet = new HashSet<>();
            for (int i = 0; i < pages; i++) {
                List<InstructionsUseIndex> list = new ArrayList<>();
                List<JSONObject> objectList = dataMongoTemplate.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "instructions_nmpa");
//                List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query(Criteria.where("_id").is("54e3194e21eb626fe1c7318eb2168cb5")), JSONObject.class, "instructions_nmpa");
                for (JSONObject jsonObject : objectList) {
                    InstructionsUseIndex instructionsUseIndex = new InstructionsUseIndex();
                    JSONArray approveCode = jsonObject.getJSONArray("approveCode");
                    if (CollUtil.isNotEmpty(approveCode)) {
                        String content = approveCode.getJSONObject(0).getString("content");
                        if (approveCodeSet.add(content)) {
                            instructionsUseIndex.setDuplication("0");
                        } else {
                            instructionsUseIndex.setDuplication("1");
                        }
                    } else {
                        instructionsUseIndex.setDuplication("0");
                    }

                    // id
                    String id = jsonObject.getString("_id");
                    instructionsUseIndex.setId(id);

                    String source = jsonObject.getString("source");
                    instructionsUseIndex.setSource(source);

                    String commonName = jsonObject.getString("commonName");
                    instructionsUseIndex.setSimpleGenericNames(commonName);
                    instructionsUseIndex.setGenericNames(commonName);

                    String innName = jsonObject.getString("innName");
                    instructionsUseIndex.setSimpleTradeNames(innName);

                    String cnName = jsonObject.getString("cnName");
                    instructionsUseIndex.setTradeNames(cnName);

                    String engName = jsonObject.getString("engName");
                    instructionsUseIndex.setSimpleEnglishName(engName);
                    instructionsUseIndex.setEnglishName(engName);

                    instructionsUseIndex.setDosageForm("");

                    String approveDate = jsonObject.getString("approveDate");
                    if (StrUtil.isNotBlank(approveDate)) {
                        try {
                            DateTimeFormatter inputFormatter1 = DateTimeFormatter.ofPattern("yyyy年MM月dd日");
                            DateTimeFormatter inputFormatter2 = DateTimeFormatter.ofPattern("yyyy年M月dd日");
                            DateTimeFormatter inputFormatter3 = DateTimeFormatter.ofPattern("yyyy年MM月d日");
                            DateTimeFormatter inputFormatter4 = DateTimeFormatter.ofPattern("yyyy年M月d日");
                            try {
                                LocalDate date = LocalDate.parse(approveDate, inputFormatter1);
                                DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                String formattedDate = date.format(outputFormatter);
                                instructionsUseIndex.setApproveDate(formattedDate);
                            } catch (Exception e) {
//                                log.error(e.getMessage(), e);

                                try {
                                    LocalDate date = LocalDate.parse(approveDate, inputFormatter2);
                                    DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                    String formattedDate = date.format(outputFormatter);
                                    instructionsUseIndex.setApproveDate(formattedDate);
                                } catch (Exception e1) {
//                                    log.error(e1.getMessage(), e1);

                                    try {
                                        LocalDate date = LocalDate.parse(approveDate, inputFormatter3);
                                        DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                        String formattedDate = date.format(outputFormatter);
                                        instructionsUseIndex.setApproveDate(formattedDate);
                                    } catch (Exception e2) {
//                                        log.error(e2.getMessage(), e2);

                                        try {
                                            LocalDate date = LocalDate.parse(approveDate, inputFormatter4);
                                            DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                            String formattedDate = date.format(outputFormatter);
                                            instructionsUseIndex.setApproveDate(formattedDate);
                                        } catch (Exception e3) {
                                            instructionsUseIndex.setApproveDate("");
                                            log.error(e3.getMessage(), e3);
                                        }
                                    }
                                }
                            }

                        } catch (Exception e) {
                            instructionsUseIndex.setApproveDate("");
                        }
                    } else {
                        instructionsUseIndex.setApproveDate("");
                    }

                    String modifyDate = jsonObject.getString("modifyDate");
                    if (StrUtil.isNotBlank(modifyDate)) {
                        try {
                            DateTimeFormatter inputFormatter1 = DateTimeFormatter.ofPattern("yyyy年MM月dd日");
                            DateTimeFormatter inputFormatter2 = DateTimeFormatter.ofPattern("yyyy年M月dd日");
                            DateTimeFormatter inputFormatter3 = DateTimeFormatter.ofPattern("yyyy年MM月d日");
                            DateTimeFormatter inputFormatter4 = DateTimeFormatter.ofPattern("yyyy年M月d日");
                            try {
                                LocalDate date = LocalDate.parse(modifyDate, inputFormatter1);
                                DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                String formattedDate = date.format(outputFormatter);
                                instructionsUseIndex.setRevisionDate(formattedDate);
                            } catch (Exception e) {
//                                log.error(e.getMessage(), e);

                                try {
                                    LocalDate date = LocalDate.parse(modifyDate, inputFormatter2);
                                    DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                    String formattedDate = date.format(outputFormatter);
                                    instructionsUseIndex.setRevisionDate(formattedDate);
                                } catch (Exception e1) {
//                                    log.error(e1.getMessage(), e1);

                                    try {
                                        LocalDate date = LocalDate.parse(modifyDate, inputFormatter3);
                                        DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                        String formattedDate = date.format(outputFormatter);
                                        instructionsUseIndex.setRevisionDate(formattedDate);
                                    } catch (Exception e2) {
//                                        log.error(e2.getMessage(), e2);

                                        try {
                                            LocalDate date = LocalDate.parse(modifyDate, inputFormatter4);
                                            DateTimeFormatter outputFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                            String formattedDate = date.format(outputFormatter);
                                            instructionsUseIndex.setRevisionDate(formattedDate);
                                        } catch (Exception e3) {
                                            instructionsUseIndex.setRevisionDate("");
                                            log.error(e3.getMessage(), e3);
                                        }
                                    }
                                }
                            }

                        } catch (Exception e) {
                            instructionsUseIndex.setRevisionDate("");
                        }
                    } else {
                        instructionsUseIndex.setRevisionDate("");
                    }


                    String marketingAuthorisationHolder = jsonObject.getString("marketingAuthorisationHolder");
                    if (StrUtil.isBlank(marketingAuthorisationHolder)) {
                        // 厂家
                        String companyName = jsonObject.getString("companyName");
                        if (StrUtil.isBlank(companyName)) {
                            String packagingPlant = jsonObject.getString("packagingPlant");
                            instructionsUseIndex.setEnterpriseName(packagingPlant);
                        } else {
                            instructionsUseIndex.setEnterpriseName(companyName);
                        }
                    } else {
                        instructionsUseIndex.setEnterpriseName(marketingAuthorisationHolder);
                    }

                    // pdf
                    String pdf = jsonObject.getString("pdf");
                    instructionsUseIndex.setPdf_name(pdf);

                    StringBuilder indicationStr = new StringBuilder();
                    JSONArray indication = jsonObject.getJSONArray("indication");
                    JSONArray effectsAndIndications = jsonObject.getJSONArray("effectsAndIndications");
                    if (CollUtil.isNotEmpty(indication)) {
                        for (Object object : indication) {
                            JSONObject inner = JSON.parseObject(JSON.toJSONString(object), JSONObject.class);
                            String tag = inner.getString("tag");
                            if (StrUtil.isNotBlank(tag) && "text".equals(tag)) {
                                indicationStr.append(inner.getString("content"));
                            }
                        }
                    } else {
                        if (CollUtil.isNotEmpty(effectsAndIndications)) {
                            for (Object object : effectsAndIndications) {
                                JSONObject inner = JSON.parseObject(JSON.toJSONString(object), JSONObject.class);
                                String tag = inner.getString("tag");
                                if (StrUtil.isNotBlank(tag) && "text".equals(tag)) {
                                    indicationStr.append(inner.getString("content"));
                                }
                            }
                        }
                    }
                    instructionsUseIndex.setIndication(indicationStr.toString());

                    StringBuilder specifications = new StringBuilder();
                    JSONArray form = jsonObject.getJSONArray("form");
                    if (CollUtil.isNotEmpty(form)) {
                        for (Object object : form) {
                            JSONObject inner = JSON.parseObject(JSON.toJSONString(object), JSONObject.class);
                            String tag = inner.getString("tag");
                            if (StrUtil.isNotBlank(tag) && "text".equals(tag)) {
                                specifications.append(inner.getString("content"));
                            }
                        }
                    }

                    instructionsUseIndex.setSpecifications(specifications.toString());


                    String approveCodeNMPA = jsonObject.getString("approveCodeNMPA");
                    if (StrUtil.isNotBlank(approveCodeNMPA)) {
                        instructionsUseIndex.setApproveCode(approveCodeNMPA);
                    }

                    //不在使用药品表规格
                    // String approveCodeNMPA = jsonObject.getString("approveCodeNMPA");
                    // if (StrUtil.isNotBlank(approveCodeNMPA)) {
                    //     DrugInfo drugInfo = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("register").is(approveCodeNMPA)), DrugInfo.class);
                    //     if (Objects.nonNull(drugInfo)) {
                    //         String drugInfoSpecifications = drugInfo.getSpecifications();
                    //         if (StrUtil.isNotBlank(drugInfoSpecifications) && !CHARACTER_STR.contains(drugInfoSpecifications)) {
                    //             specifications = new StringBuilder();
                    //             specifications.append(drugInfoSpecifications);
                    //         }
                    //     }
                    //     instructionsUseIndex.setSpecifications(specifications.toString());
                    // }



                    StringBuilder usage = new StringBuilder();
                    JSONArray dosage = jsonObject.getJSONArray("dosage");
                    if (CollUtil.isNotEmpty(dosage)) {
                        for (Object object : dosage) {
                            JSONObject inner = JSON.parseObject(JSON.toJSONString(object), JSONObject.class);
                            String tag = inner.getString("tag");
                            if (StrUtil.isNotBlank(tag) && "text".equals(tag)) {
                                usage.append(inner.getString("content"));
                            }
                        }
                    }
                    instructionsUseIndex.setUsage(usage.toString());

                    StringBuilder taboo = new StringBuilder();
                    JSONArray contraindications = jsonObject.getJSONArray("contraindications");
                    if (CollUtil.isNotEmpty(contraindications)) {
                        for (Object object : contraindications) {
                            JSONObject inner = JSON.parseObject(JSON.toJSONString(object), JSONObject.class);
                            String tag = inner.getString("tag");
                            if (StrUtil.isNotBlank(tag) && "text".equals(tag)) {
                                taboo.append(inner.getString("content"));
                            }
                        }
                    }
                    instructionsUseIndex.setTaboo(taboo.toString());

                    list.add(instructionsUseIndex);
                }
                elasticsearchRestTemplate.save(list);
                log.info("---------------用药助手说明书数据第[{}]次写入1000条------------------", i+1);
            }
        }
        log.info("---------------导入完成------------------");
    }



    @Test
    public void instructions() {
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
                jsonObject.put("selected",doc.getString("selected"));


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

    /**
     * 批量插入并捕获单条失败的数据
     */
    private void batchInsert(MongoTemplate template, List<JSONObject> list, String collectionName) {
        if (list.isEmpty()) return;

        int batchSize = 500; // 每批插入数量，可调优
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

    /**
     * 过滤掉JSON中嵌套超过三层的内容
     * 保留三层及以下的嵌套结构不变，只处理超过三层的嵌套
     * 特别保护 _id 字段不被修改
     *
     * @param jsonObject 原始JSON对象
     * @return 过滤后的JSON对象
     */
    private JSONObject filterNestedJson(JSONObject jsonObject) {
        if (jsonObject == null) {
            return null;
        }

        // 保存原始的 _id 值并优先处理
        Object originalId = jsonObject.get("_id");

        // 创建新的JSONObject用于存储结果
        JSONObject result = new JSONObject();

        // 首先处理 _id 字段，确保它不被修改
        if (originalId != null) {
            result.put("_id", originalId);
        }

        // 遍历原始JSONObject的所有键值对
        for (Map.Entry<String, Object> entry : jsonObject.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();

            // 跳过已经处理的 _id 字段
            if ("_id".equals(key)) {
                continue;
            }

            // 如果值是基本类型或者null，直接保留
            if (isPrimitiveOrWrapper(value)) {
                result.put(key, value);
            }
            // 如果值是JSONObject（第二层嵌套）
            else if (value instanceof JSONObject) {
                // 对第二层对象递归处理
                result.put(key, filterNestedJsonLevel((JSONObject) value, 2));
            }
            // 如果值是JSONArray
            else if (value instanceof JSONArray) {
                result.put(key, filterNestedJsonLevel((JSONArray) value, 2));
            }
            // 其他复杂对象（第二层），直接替换为标识字符串
            else {
                result.put(key, "[Complex Object Removed]");
            }
        }

        return result;
    }

    /**
     * 递归处理嵌套对象，根据层级决定是否过滤
     *
     * @param jsonObject 待处理的JSON对象
     * @param level 当前嵌套层级（从1开始）
     * @return 处理后的JSON对象
     */
    private JSONObject filterNestedJsonLevel(JSONObject jsonObject, int level) {
        if (jsonObject == null) {
            return null;
        }

        // 如果是第三层，保留结构不变
        if (level == 3) {
            JSONObject result = new JSONObject();
            for (Map.Entry<String, Object> entry : jsonObject.entrySet()) {
                String key = entry.getKey();
                Object value = entry.getValue();

                // 保留第三层的基本类型值
                if (isPrimitiveOrWrapper(value)) {
                    result.put(key, value);
                } else {
                    // 第三层中的复杂对象替换为标识字符串
                    result.put(key, "[Nested Object Removed]");
                }
            }
            return result;
        }

        // 对于第一层和第二层，继续递归处理
        JSONObject result = new JSONObject();
        for (Map.Entry<String, Object> entry : jsonObject.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();

            if (isPrimitiveOrWrapper(value)) {
                result.put(key, value);
            } else if (value instanceof JSONObject) {
                result.put(key, filterNestedJsonLevel((JSONObject) value, level + 1));
            } else if (value instanceof JSONArray) {
                result.put(key, filterNestedJsonLevel((JSONArray) value, level + 1));
            } else {
                result.put(key, "[Complex Object Removed]");
            }
        }

        return result;
    }

    /**
     * 递归处理嵌套数组，根据层级决定是否过滤
     *
     * @param jsonArray 待处理的JSON数组
     * @param level 当前嵌套层级（从1开始）
     * @return 处理后的JSON数组
     */
    private JSONArray filterNestedJsonLevel(JSONArray jsonArray, int level) {
        if (jsonArray == null) {
            return null;
        }

        JSONArray result = new JSONArray();
        for (int i = 0; i < jsonArray.size(); i++) {
            Object item = jsonArray.get(i);

            if (isPrimitiveOrWrapper(item)) {
                result.add(item);
            } else if (item instanceof JSONObject) {
                result.add(filterNestedJsonLevel((JSONObject) item, level + 1));
            } else if (item instanceof JSONArray) {
                result.add(filterNestedJsonLevel((JSONArray) item, level + 1));
            } else {
                result.add("[Complex Object Removed]");
            }
        }

        return result;
    }

    /**
     * 判断对象是否为基本类型或其包装类
     *
     * @param obj 待判断对象
     * @return 是否为基本类型
     */
    private boolean isPrimitiveOrWrapper(Object obj) {
        if (obj == null) {
            return true;
        }

        return obj instanceof String ||
                obj instanceof Number ||
                obj instanceof Boolean ||
                obj instanceof Character ||
                obj instanceof Date ||
                obj instanceof Enum;
    }



    //说明书mini表
    @Test
    void test13(){
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), "instructions_nmpa");
        long page = (instructionsCleaning) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 ).limit(1000), JSONObject.class, "instructions_nmpa");
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
                JSONArray indication = doc.getJSONArray("indication");
                if (ObjectUtil.isEmpty(indication)) {
                    indication = doc.getJSONArray("effectsAndIndications");
                }
                jsonObject.put("indication", indication);

                jsonObject.put("pdf", doc.get("pdf"));


                try {
//                    dataMongoTemplatex.insert(doc, tableName);
                    dataMongoTemplatex.insert(jsonObject, "instructions_mini_1");
                } catch (Exception e) {
                    log.error(doc.toString());
                }

            }

            System.out.println("加载了条数：" + (i + 1) * 1000);
        }
        System.out.println("加载完成");


    }



    @Test
    void test() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_CRAWLER_DATABASE")));

        long instructionsCleaning = dataMongoTemplate.count(new Query(), "wanfang_zhuanli_drug_detail_clean");
        long page = (instructionsCleaning) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000).limit(1000), JSONObject.class, "wanfang_zhuanli_drug_detail_clean");

            ArrayList<Patent> patents = new ArrayList<>();
            for (JSONObject jsonObject : instructionsCleaning1) {

                Patent patent = new Patent();
                JSONArray patentTitle = jsonObject.getJSONArray("patent_title");
                if (CollUtil.isNotEmpty(patentTitle)){
                    patent.setTitle(patentTitle.getString(0));
                }

                String type = jsonObject.getString("patent_type");
                patent.setType(type);

                JSONArray patentDetail = jsonObject.getJSONArray("patentee");
                if (CollUtil.isNotEmpty(patentDetail)){
                    try {
                        patent.setPatentee(patentDetail.toJavaList(String.class));
                    }catch (Exception e){
                        try {
                            List<List> javaList = patentDetail.toJavaList(List.class);
                            ArrayList<String> strings = new ArrayList<>();
                            for (List list : javaList) {
                                strings.addAll(list);
                            }
                            patent.setPatentee(strings);
                        }catch (Exception ex){
                            log.error(patentDetail.toString());
                        }

                    }

                }

                String publicationNumber = jsonObject.getString("patent_number");
                patent.setPatentNumber(publicationNumber);

                SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd");


                String applicationDate = jsonObject.getString("application_date");
                if (ObjectUtils.isNotEmpty(applicationDate)) {

                    applicationDate = applicationDate.substring(0,10);

                    applicationDate = applicationDate.replaceAll("-","");

                    patent.setApplicationTime(Integer.parseInt(applicationDate));



                }


                String announcementDate = jsonObject.getString("announcement_date");
                if (ObjectUtils.isNotEmpty(announcementDate)) {
                    announcementDate = announcementDate.substring(0,10);

                    announcementDate = announcementDate.replaceAll("-","");

                    patent.setPublicDate(Integer.parseInt(announcementDate));

                }


                //专利状态
                JSONArray array = jsonObject.getJSONArray("authorization");
                if (CollUtil.isNotEmpty(array)){
                    patent.setStatus(array.getJSONObject(0).getString("legal_status"));
                    patent.setStatusInformation(array.getJSONObject(0).getString("legal_status_information"));
                }


                patents.add(patent);

            }
            mongoTemplate.insert(patents, "evaluation_patent_1");


            log.info("已写入的数据数量：{}条",(i+1)*1000);
        }
    }






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

    //再加一版说明书
    @Test
    void test9() {
        String table = "instructions_nmpa";
            MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        SimpleMongoClientDatabaseFactory factory = new SimpleMongoClientDatabaseFactory(
                MongoClients.create(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")
                        + "connectTimeoutMS=30000"
                        + "&socketTimeoutMS=60000"
                        + "&maxIdleTimeMS=300000"
                        + "&heartbeatFrequencyMS=10000"),
                "evimed_new"
        );
        MongoTemplate targetMongoTemplate = new MongoTemplate(factory);

        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
            long page = (instructionsCleaning) / 1000 + 1;
            for (int i = 0; i < page; i++) {
                List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 ).limit(1000), JSONObject.class, table);
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
                    //注册证号
                    jsonObject.put("approveCode", doc.get("approveCode"));
                    //pdf
                    jsonObject.put("pdf", doc.get("pdf"));
                    //适应症
                    jsonObject.put("indication",getJsonList(doc.get("indication")) );
                    //一般名称
                    jsonObject.put("commonName",doc.get("commonName") );
                    //innName
                    jsonObject.put("innName", doc.get("innName"));
                    //英文名称
                    jsonObject.put("engName", doc.get("engName"));
                    //简写
                    jsonObject.put("cnName", doc.get("cnName"));
                    //展示用的商品名
                    jsonObject.put("showName", doc.get("showName"));
                    //用法用量
                    jsonObject.put("dosage", getJsonList(doc.get("dosage")));
                    //不良反应
                    jsonObject.put("adverseReactions", getJsonList(doc.get("adverseReactions")));
                    //禁忌
                    jsonObject.put("contraindications", getJsonList(doc.get("contraindications")));
                    //注意事项
                    jsonObject.put("precautions", getJsonList(doc.get("precautions")));
                    //孕妇
                    jsonObject.put("useInPregLact",getJsonList( doc.get("useInPregLact")));
                    //儿童
                    jsonObject.put("useInChildren",getJsonList( doc.get("useInChildren")));
                    // 老年
                    jsonObject.put("useInElderly",getJsonList(doc.get("useInElderly")));
                    //药理作用
                    jsonObject.put("mechanismAction",getJsonList( doc.get("mechanismAction")));
                    //毒理研究
                    jsonObject.put("poison",getJsonList( doc.get("poison")));
                    //药物过量
                    jsonObject.put("overdosage", getJsonList(doc.get("overdosage")));


                    try {
                        targetMongoTemplate.insert(jsonObject, "instructions_clean");
                    }catch (Exception e){
                       e.printStackTrace();

                    }

                }


                System.out.println("加载了条数：" + (i + 1) * 1000);
            }
            System.out.println("加载完成");



    }




    @Test
    void test11() {
        String table = "instructions_nmpa";
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
        long page = (instructionsCleaning ) / 1000 + 1;
        int zhong = 0;
        int xi = 0;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 ).limit(1000), JSONObject.class, table);
            for (JSONObject doc : instructionsCleaning1) {
                String string = doc.getString("approveCodeNMPA");

                List<JSONObject> jsonObjects = dataMongoTemplatex.find(new Query(Criteria.where("register").is(string)), JSONObject.class, "evaluation_drug_info_v2");


                if (jsonObjects.size() > 0 && "中成药".equals(jsonObjects.get(0).getString("drugCategory"))) {
                    zhong++;
                }
                if (jsonObjects.size() > 0 && "西药".equals(jsonObjects.get(0).getString("drugCategory"))) {
                    xi++;
                }



            }

            }
        System.out.println("中成药:"+zhong);
        System.out.println("西药:"+xi);

    }




    @Test
    void test10() {
        String table = "instructions_nmpa";
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        SimpleMongoClientDatabaseFactory factory = new SimpleMongoClientDatabaseFactory(
                MongoClients.create(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")
                        + "connectTimeoutMS=30000"
                        + "&socketTimeoutMS=60000"
                        + "&maxIdleTimeMS=300000"
                        + "&heartbeatFrequencyMS=10000"),
                "evimed_new"
        );
        MongoTemplate targetMongoTemplate = new MongoTemplate(factory);

            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query(Criteria.where("approveCodeNMPA").is("国药准字S20240040")), JSONObject.class, table);
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
                //注册证号
                jsonObject.put("approveCode", doc.get("approveCode"));
                //pdf
                jsonObject.put("pdf", doc.get("pdf"));
                //适应症
                jsonObject.put("indication",getJsonList(doc.get("indication")) );
                //一般名称
                jsonObject.put("commonName",doc.get("commonName") );
                //innName
                jsonObject.put("innName", doc.get("innName"));
                //英文名称
                jsonObject.put("engName", doc.get("engName"));
                //简写
                jsonObject.put("cnName", doc.get("cnName"));
                //展示用的商品名
                jsonObject.put("showName", doc.get("showName"));
                //用法用量
                jsonObject.put("dosage", getJsonList(doc.get("dosage")));
                //不良反应
                jsonObject.put("adverseReactions", getJsonList(doc.get("adverseReactions")));
                //禁忌
                jsonObject.put("contraindications", getJsonList(doc.get("contraindications")));
                //注意事项
                jsonObject.put("precautions", getJsonList(doc.get("precautions")));
                //孕妇
                jsonObject.put("useInPregLact",getJsonList( doc.get("useInPregLact")));
                //儿童
                jsonObject.put("useInChildren",getJsonList( doc.get("useInChildren")));
                // 老年
                jsonObject.put("useInElderly",getJsonList(doc.get("useInElderly")));
                //药理作用
                jsonObject.put("mechanismAction",getJsonList( doc.get("mechanismAction")));
                //毒理研究
                jsonObject.put("poison",getJsonList( doc.get("poison")));
                //药物过量
                jsonObject.put("overdosage", getJsonList(doc.get("overdosage")));


                try {
                    targetMongoTemplate.remove(new  Query(Criteria.where("approveCode").is("国药准字S20240040")), "instructions_clean");
                    targetMongoTemplate.insert(jsonObject, "instructions_clean");
                }catch (Exception e){
                    e.printStackTrace();

                }

            }






    }


    @Test
    void test8() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        List<JSONObject> jsonObjects = dataMongoTemplate.find(new Query(), JSONObject.class, "Sheet1");
        for (JSONObject jsonObject : jsonObjects) {
            String title = jsonObject.getString("combine_id");
            List<JSONObject> jsonObjects1 = dataMongoTemplate.find(new Query(Criteria.where("combine_id").is(title)), JSONObject.class, "mergedCollectionx");
            if (jsonObjects1.size() > 0){
                dataMongoTemplate.insert(jsonObjects1, "mergedCollection他克莫司");
            }
        }
    }


    @Test
    void test7() {
        JSONObject jsonObject = new JSONObject();
        ArrayList<String> strings = new ArrayList<>();
        strings.add("二甲双胍");
        jsonObject.put("drugSynonym",strings);
        ArrayList<String> strings1 = new ArrayList<>();
        strings1.add("不良反应");
        jsonObject.put("diseaseSynonym",strings1);
        jsonObject.put("title","二甲双胍的不良反应");
        Object s = evidenceFeign.vectorRetrieval(jsonObject);
        System.out.println(s);


    }

    @Test
    void test6() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        List<String> drugNames = Arrays.asList(  "頻脈");
        StringBuilder regexPattern = new StringBuilder();
        for (int i = 0; i < drugNames.size(); i++) {
            regexPattern.append(Pattern.quote(drugNames.get(i)));
            if (i < drugNames.size() - 1) {
                regexPattern.append("|");
            }
        }

        Criteria criteria1 = Criteria.where("有害事象").regex(regexPattern.toString(),"i" );
        List<JSONObject> jsonObjects = dataMongoTemplate.find(new Query(criteria1), JSONObject.class, "reac");
        HashSet<String> strings = new HashSet<>();
        for (JSONObject jsonObject : jsonObjects) {
            String string = jsonObject.getString("識別番号");
            strings.add(string);
        }

        System.out.println(strings.size());


    }

    @Test
    void test4() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        List<String> drugNames = Arrays.asList("ＦＫ５０６", "PROGRAF", "TACROLIMUS","タクロリムス","プログラフ");

        List<String> jdPt1 = Arrays.asList(
        "高血圧",
                "高血圧緊急症",
                "収縮期高血圧",
                "悪性高血圧",
                "拡張期高血圧",
                "妊娠高血圧",
                "高血圧クリーゼ",
                "白衣性高血圧",
                "本態性高血圧症",
                "高血圧切迫症",
                "進行性高血圧",
                "二次性高血圧",
                "術後高血圧",
                "右室高血圧",
                "透析による高血圧",
                "処置による高血圧",
                "静脈性高血圧",
                "新生児高血圧",
                "門脈肺高血圧症",
                "断薬性高血圧",
                "不安定高血圧",
                "仰臥位高血圧",
                "心電図ＱＴ延長",
                "ＱＴ延長症候群",
                "先天性ＱＴ延長症候群",
                "心電図ＱＴ間隔異常",
                "心房細動",
                "心細動",
                "心停止",
                "心肺停止",
                "うっ血性心不全",
                "心筋梗塞",
                "急性心筋梗塞",
                "無症候性心筋梗塞",
                "処置後心筋梗塞",
                "周術期心筋梗塞",
                "心筋梗塞の心電図所見",
                "冠動脈攣縮",
                "心室性頻脈",
                "洞性頻脈",
                "上室性頻脈",
                "心房頻脈",
                "発作性頻脈",
                "頻脈性不整脈",
                "胎児頻脈",
                "心室性頻脈性不整脈",
                "頻脈誘発性心筋症",
                "新生児頻脈",
                "接合部異所性頻脈",
                "胎児頻脈性不整脈",
                "上室性頻脈性不整脈",
                "胎児一過性頻脈異常",
                "心室性不整脈",
                "心不全",
                "急性心不全",
                "新生児心不全",
                "心肺不全",
                "慢性心不全",
                "高拍出性心不全",
                "駆出率低下を伴う心不全",
                "駆出率の保たれた心不全",
                "心室肥厚",
                "室上性心律不齐",
                "頻脈"
        );

        StringBuilder regexPattern = new StringBuilder();
        for (int i = 0; i < drugNames.size(); i++) {
            regexPattern.append(Pattern.quote(drugNames.get(i)));
            if (i < drugNames.size() - 1) {
                regexPattern.append("|");
            }
        }

//        for (int i = 0; i < jdPt1.size(); i++) {
//            regexPattern.append(Pattern.quote(jdPt1.get(i)));
//            if (i < jdPt1.size() - 1) {
//                regexPattern.append("|");
//            }
//        }

        // 创建 Criteria 使用正则表达式并忽略大小写
        Criteria criteria1 = Criteria.where("医薬品（一般名）").regex(regexPattern.toString(),"i" );
        Criteria criteria2 = Criteria.where("医薬品（販売名）").regex(regexPattern.toString(),"i" );
        Criteria criteria5 = Criteria.where("有害事象").regex(regexPattern.toString(),"i" );
        Criteria criteria3 = Criteria.where("医薬品の関与").is("被疑薬");
        Criteria criteria = new Criteria();
        criteria.orOperator(criteria1, criteria2);
        criteria.andOperator(criteria3);



        // 创建 Query
        Query query = new Query(criteria);

        // 执行查询
        List<JSONObject> results = dataMongoTemplate.find(query, JSONObject.class,"drug");

        HashSet<String> strings = new HashSet<>();
        // 处理结果
        results.forEach(result -> {
            String string = result.getString("識別番号");
            strings.add(string);
        });

        Criteria criteria4 = Criteria.where("識別番号").in(strings);
        Query query1 = new Query(criteria4);
        List<JSONObject> jsonObjectsDemo = dataMongoTemplate.find(query1, JSONObject.class,"demo");

        ArrayList<Object> objects = new ArrayList<>();
        jsonObjectsDemo.forEach(jsonObject -> {
            String string = jsonObject.getString("識別番号");
            List<JSONObject> jsonObjectsDrug = dataMongoTemplate.find(new Query(Criteria.where("識別番号").is(string)), JSONObject.class,"drug");
            List<JSONObject> jsonObjectsHist = dataMongoTemplate.find(new Query(Criteria.where("識別番号").is(string)), JSONObject.class,"hist");
            List<JSONObject> jsonObjectsReac = dataMongoTemplate.find(new Query(Criteria.where("識別番号").is(string)), JSONObject.class,"reac");
            ArrayList<String> strings1 = new ArrayList<>();
            ArrayList<String> strings2 = new ArrayList<>();
            jsonObjectsDrug.forEach(jsonObject1 -> {
                strings1.add(jsonObject1.getString("医薬品（一般名）"));
                strings2.add(jsonObject1.getString("医薬品（販売名）"));
            });
            ArrayList<String> strings3 = new ArrayList<>();
            jsonObjectsHist.forEach(jsonObject1 -> {
                strings3.add(jsonObject1.getString("原疾患等"));
            });
            ArrayList<String> strings4 = new ArrayList<>();
            ArrayList<String> strings5 = new ArrayList<>();
            jsonObjectsReac.forEach(jsonObject1 -> {
//                dataMongoTemplate.save(jsonObject1,"reac_list");
                strings4.add(jsonObject1.getString("有害事象"));
                strings5.add(jsonObject1.getString("転帰"));
            });

            jsonObject.put("drug",strings1);
            jsonObject.put("pro_ai",strings2);
            jsonObject.put("disease",strings3);
            jsonObject.put("pt_list",strings4);
            jsonObject.put("outcome",strings5);
            objects.add(jsonObject);
        });


        objects.forEach(jsonObject -> {
            dataMongoTemplate.save(jsonObject,"demo_drug_disease_pt_1");
        });






    }



    
    @Test
    void test3() {
        long begin = System.currentTimeMillis();
        JSONObject otherAdverseReactionAnalysis = new JSONObject();
        JSONObject otherAdverseReactionAnalysis1 = new JSONObject();
        try {
            otherAdverseReactionAnalysis = lxGptService.otherAdverseReactionAnalysis("甲磺酸伊马替尼片");
            otherAdverseReactionAnalysis1 = lxGptService.otherAdverseReactionAnalysis("二甲双胍");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (otherAdverseReactionAnalysis.getString("otherAdverseReaction") == null) {
                otherAdverseReactionAnalysis.put("otherAdverseReaction", "无");
            }
        }
    }
    @Test
    void test2() {
        long begin = System.currentTimeMillis();
        JSONObject drugInteractionAnalysis = new JSONObject();
        JSONObject drugInteractionAnalysis1 = new JSONObject();
        try {
            drugInteractionAnalysis = lxGptService.drugInteractionAnalysis("甲磺酸伊马替尼片");
            drugInteractionAnalysis1 = lxGptService.drugInteractionAnalysis("二甲双胍");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (drugInteractionAnalysis.getString("drugInteraction") == null) {
                drugInteractionAnalysis.put("drugInteraction", "无");
            }
        }
    }
    
    @Test
    void test1() {
        long begin = System.currentTimeMillis();
        JSONObject specialCrowdAnalysis = new JSONObject();
        JSONObject specialCrowdAnalysis1 = new JSONObject();
        try {
//            specialCrowdAnalysis = lxGptService.specialCrowdAnalysis("甲磺酸伊马替尼片", null);
//            specialCrowdAnalysis1 = lxGptService.specialCrowdAnalysis("二甲双胍", null);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (specialCrowdAnalysis.getString("pregnantWomen") == null) {
                specialCrowdAnalysis.put("pregnantWomen", "无");
            }
            if (specialCrowdAnalysis.getString("childrenMedicine") == null) {
                specialCrowdAnalysis.put("childrenMedicine", "无");
            }
            if (specialCrowdAnalysis.getString("geriatricMedicine") == null) {
                specialCrowdAnalysis.put("geriatricMedicine", "无");
            }
            if (specialCrowdAnalysis.getString("liverKidney") == null) {
                specialCrowdAnalysis.put("liverKidney", "无");
            }
        }
    }
    
    @Test
    public void importdata(){
        ExcelReader excelReader = new ExcelReader("C:\\Users\\wxm\\Desktop\\医保药品.xlsx",0);
        List<Map<String, Object>> maps = excelReader.readAll();
        mongoTemplate.insert(maps,"medical_insurance_drugs");
    }

    @Test
    public void main() throws IOException {
        Map<String,Object> map = new HashMap<>();
        String accessToken = getAccessToken();
        Map<String,Object> content = new HashMap<>();
        content.put("role","user");
        content.put("content","你是谁？");
        map.put("messages", Arrays.asList(content));
        String res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/eb-instant?access_token="+accessToken,JSONObject.toJSONString(map));
        System.out.println(res);
    }

    private static String  getAccessToken() throws IOException {
        final OkHttpClient HTTP_CLIENT = new OkHttpClient().newBuilder().build();
        MediaType mediaType = MediaType.parse("application/json");
        RequestBody body = RequestBody.create(mediaType, "");
        Request request = new Request.Builder()
                .url("https://aip.baidubce.com/oauth/2.0/token?client_id=" + System.getenv("ERNIE_CLIENT_ID")
                    + "&client_secret=" + System.getenv("ERNIE_CLIENT_SECRET")
                    + "&grant_type=client_credentials")
                .method("POST", body)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .build();
        Response response = HTTP_CLIENT.newCall(request).execute();
        JSONObject jsonObject = JSONObject.parseObject(response.body().string());
        System.out.println(jsonObject.toJSONString());
        return jsonObject.getString("access_token");
    }


    @Test
    public void importconcentrate(){
        ExcelReader excelReader = new ExcelReader("C:\\Users\\wxm\\Desktop\\集采药物.xlsx",0);
        List<Map<String, Object>> maps = excelReader.readAll();
        mongoTemplate.insert(maps,"country_concentrate_drugs");
    }

    @Test
    public void importBase(){
        ExcelReader excelReader = new ExcelReader("C:\\Users\\wxm\\Desktop\\国家基本药物.xlsx",0);
        List<Map<String, Object>> maps = excelReader.readAll();
        mongoTemplate.insert(maps,"country_base_drugs");
    }

    @Test
    void testStream() {
        String urlStr = "http://120.46.46.103:45566/stream?data={\"content\": \"鲁迅为什么暴打周树人\", \"model\": \"gpt-3.5-turbo\"}";
        long statr = System.currentTimeMillis();
        log.info("开始请求接口url:{}", urlStr);
        InputStream is = null;
        try {
            URL url = new URL(urlStr);
            URLConnection conn = url.openConnection();
            is = conn.getInputStream();

            byte[] b = new byte[1024];
            int len = -1;
            long end = System.currentTimeMillis();
            log.info("接口url:{},请求开始流式输出{}", urlStr, end - statr);
            while ((len = is.read(b)) != -1) {

                String line = new String(b, 0, len, "utf-8");
                // 处理 event stream 数据
                System.out.println(line);
            }
        } catch (IOException e) {
            log.error("请求模型接口异常", e);
        } finally {
            if (!Objects.isNull(is)) {
                try {
                    //12.关闭输入流
                    is.close();
                } catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    @Test
    void testStream2() throws IOException {
        OkHttpClient HTTP_CLIENT = new OkHttpClient().newBuilder().build();
        Request request = new Request.Builder()
                .url("http://120.46.46.103:45566/stream?data={\"content\": \"鲁迅为什么暴打周树人\", \"model\": \"gpt-3.5-turbo\"}")
                .addHeader("Content-Type", "application/json")
                .build();
        // 流式返回
        Response response = HTTP_CLIENT.newCall(request).execute();
        if (response.isSuccessful()) {
            ResponseBody responseBody = response.body();
            if (responseBody != null) {
                InputStream inputStream = responseBody.byteStream();
                byte[] buffer = new byte[1024];
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    String data = new String(buffer, 0, bytesRead);
                    System.out.println(data);
                }
            }
        } else {
            System.out.println("流式请求异常: " + response);
        }
    }

    @Test
    void testGpt() throws IOException {
        String apiKey = System.getenv("OPENAI_API_KEY");
        org.junit.jupiter.api.Assumptions.assumeTrue(
                apiKey != null && !apiKey.trim().isEmpty(),
                "OPENAI_API_KEY is required for this external integration test"
        );
        String baseUrl = "https://api.chatanywhere.com.cn/v1/chat/completions";
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .build();
        JSONObject json = new JSONObject();
        json.put("model", "gpt-3.5-turbo-1106");
        json.put("messages", new JSONArray());
        JSONObject dataJson = new JSONObject();
        dataJson.put("role", "user");
        String answer = "Say this is a test!";
        dataJson.put("content", answer);
        json.getJSONArray("messages").add(dataJson);
        //流式数据
        json.put("stream", true);
        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
        Request request = new Request.Builder()
                .url(baseUrl)
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " + apiKey)
                .post(body)
                .build();
        // 流式返回
        Response response = client.newCall(request).execute();
        if (response.isSuccessful()) {
            ResponseBody responseBody = response.body();
            if (responseBody != null) {
                InputStream inputStream = responseBody.byteStream();
                byte[] buffer = new byte[1024];
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    String data = new String(buffer, 0, bytesRead);
                    //System.out.println(data);
                    String[] split = data.split("data: ");
                    for (String s : split) {
                        //System.out.println(s);
                        if (StringUtils.isNotBlank(s) && !s.contains("DONE")) {
                            JSONObject jsonObject = JSONObject.parseObject(s);
                            JSONArray choices = jsonObject.getJSONArray("choices");
                            for (int i = 0; i < choices.size(); i++) {
                                JSONObject delta = choices.getJSONObject(i).getJSONObject("delta");
                                if (!delta.isEmpty()) {
                                    String content = delta.getString("content");
                                    if (StringUtils.isNotBlank(content)) {
                                        System.out.println(content);
                                    }
                                }
                            }
                        }
                    }

                }
            }
        } else {
            System.out.println("流式请求异常: " + response);
        }
    }


    @Test
    void test5() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        List<String> drugNames = Arrays.asList("ＦＫ５０６", "PROGRAF", "TACROLIMUS", "タクロリムス", "プログラフ");
        StringBuilder regexPattern = new StringBuilder();
        for (int i = 0; i < drugNames.size(); i++) {
            regexPattern.append(Pattern.quote(drugNames.get(i)));
            if (i < drugNames.size() - 1) {
                regexPattern.append("|");
            }
        }

        // 创建 Criteria 使用正则表达式并忽略大小写
        Criteria criteria1 = Criteria.where("医薬品（一般名）").regex(regexPattern.toString(), "i");
        Criteria criteria2 = Criteria.where("医薬品（販売名）").regex(regexPattern.toString(), "i");
        Criteria criteria3 = Criteria.where("医薬品の関与").is("被疑薬");
        Criteria criteria = new Criteria();
        criteria.orOperator(criteria1, criteria2);
        criteria.andOperator(criteria3);


        // 创建 Query
        Query query = new Query(criteria);

        // 执行查询
        List<JSONObject> results = dataMongoTemplate.find(query, JSONObject.class, "drug");
        results.forEach(result -> {
            try {
                String 投与開始日Str = result.getString("投与開始日");
                String 投与終了日Str = result.getString("投与終了日");

                if (StringUtils.isNotBlank(投与開始日Str) && StringUtils.isNotBlank(投与終了日Str)) {
                    SimpleDateFormat dateFormat = new SimpleDateFormat("yyyyMMdd"); // 根据实际日期格式调整
                    Date 投与開始日 = dateFormat.parse(投与開始日Str);
                    Date 投与終了日 = dateFormat.parse(投与終了日Str);

                    long diffInMillies = 投与終了日.getTime() - 投与開始日.getTime();
                    long diff = TimeUnit.DAYS.convert(diffInMillies, TimeUnit.MILLISECONDS) + 1;

                    if (diff > 5000) {
                        result.put("drugDate", "");
                    } else {
                        result.put("drugDate", String.valueOf(diff));
                    }
                } else {
                    result.put("drugDate", "");
                }
            } catch (ParseException e) {
                result.put("drugDate", "");
                log.error("日期解析错误: ", e);
            } catch (Exception e) {
                result.put("drugDate", "");
                log.error("其他错误: ", e);
            }
            dataMongoTemplate.save(result, "drugInfo");
        });

    }



    //垃圾代码
    @Test
    public void testlaji() {
        //表名
        ArrayList<String> strings = new ArrayList<>();
        strings.add("drugInfo");
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        strings.forEach(tableName -> {
            List<JSONObject> list = dataMongoTemplate.find(new Query(), JSONObject.class, tableName);

            for (JSONObject doc : list) {
            }


        });


    }



}



