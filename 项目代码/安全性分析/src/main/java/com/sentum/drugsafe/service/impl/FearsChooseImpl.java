package com.sentum.drugsafe.service.impl;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.result.DeleteResult;
import com.sentum.drugsafe.pojo.AdverseForCaseIndex;
import com.sentum.drugsafe.pojo.AdverseIndex;
import com.sentum.drugsafe.pojo.RoleCod;
import com.sentum.drugsafe.service.FearsChoose;
import com.sentum.drugsafe.utils.FearsMongoUtil;
import com.sentum.drugsafe.utils.JsonKeyToLower;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.bson.Document;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.io.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
public class FearsChooseImpl implements FearsChoose {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }

    @Autowired
    private FearsMongoUtil mongoUtil;
    @Autowired
    private MongoTemplate mongoTemplate;

    @Async
    @Override
    public void getDrug(String databaseName) {
        String[] split = databaseName.split(",");
        List<String> drugs = Arrays.asList(split);
        String drugName = drugs.get(0);

        // 构建药品搜索的正则表达式
        String drugRegex = drugs.stream()
                .map(Pattern::quote)
                .reduce((a, b) -> a + "|" + b)
                .orElse("");

        for (int year = 2004; year <= 2025; year++) {
            for (int month = 1; month <= 4; month++) {
                String quarterTable = String.valueOf(year).substring(2, 4) + "Q" + month;

                // 查询条件构建
                Criteria drugSearchCriteria = buildDrugSearchCriteria(drugRegex);
                Query query = new Query(drugSearchCriteria);

//                 分页处理药品数据
                processInBatches(query, "DRUG" + quarterTable, "drug_" + drugName, 1000);

//                // 获取主键集合
//                HashSet<String> primaryIds = getPrimaryIds("drug_" + drugName);
//
////                // 构建主键查询条件
//                Criteria primaryIdCriteria = Criteria.where("primaryid").in(primaryIds)
//                        .orOperator(Criteria.where("ISR").in(primaryIds));
//                Query primaryKeyQuery = new Query(primaryIdCriteria);
//
//                // 插入其他表的数据
//                processInBatches(primaryKeyQuery, "DEMO" + quarterTable, "demo_" + drugName, 1000);
//                processInBatches(primaryKeyQuery, "INDI" + quarterTable, "indi_" + drugName, 1000);
//                processInBatches(primaryKeyQuery, "OUTC" + quarterTable, "outc_" + drugName, 1000);
                log.info("{}处理完成",year);
            }
        }
    }

    /**
     * 构建药品搜索条件
     */
    private Criteria buildDrugSearchCriteria(String drugRegex) {
        Criteria drugNameCriteria = new Criteria().orOperator(
                Criteria.where("DRUGNAME").regex(drugRegex, "i"),
                Criteria.where("drugname").regex(drugRegex, "i"),
                Criteria.where("prod_ai").regex(drugRegex, "i")
        );
        Criteria roleCriteria = new Criteria().orOperator(
                Criteria.where("ROLE_COD").is("PS"),
                Criteria.where("role_cod").is("PS")
        );
        return new Criteria().andOperator(drugNameCriteria, roleCriteria);
    }

    /**
     * 分页处理 MongoDB 数据
     */
    private void processInBatches(Query query, String sourceCollection, String targetCollection, int batchSize) {
        int skip = 0;
        List<JSONObject> batchRecords;
        do {
            query.skip(skip).limit(batchSize); // 分页查询
            batchRecords = mongoUtil.mongo.find(query, JSONObject.class, sourceCollection);
            if (CollUtil.isNotEmpty(batchRecords)) {
                List<JSONObject> processedRecords = processJsonObjects(batchRecords);
                mongoUtil.mongo.insert(processedRecords, targetCollection);
            }
            skip += batchSize; // 更新跳过记录数
        } while (batchRecords != null && !batchRecords.isEmpty());
    }

    /**
     * 处理 JSON 对象列表
     */
    private List<JSONObject> processJsonObjects(List<JSONObject> jsonObjects) {
        return jsonObjects.stream()
                .peek(this::convertKeys)
                .collect(Collectors.toList());
    }

    /**
     * 转换 JSON 键并标准化字段名
     */
    private void convertKeys(JSONObject jsonObject) {
        if (jsonObject.containsKey("ISR")) {
            jsonObject.put("primaryid", jsonObject.getString("ISR"));
            jsonObject.remove("ISR");
        }
        if (jsonObject.containsKey("CASE")) {
            jsonObject.put("caseid", jsonObject.getString("CASE"));
            jsonObject.remove("CASE");
        }
        if (jsonObject.containsKey("ROUTE")){
            jsonObject.put("route", jsonObject.getString("ROUTE"));
            jsonObject.remove("ROUTE");
        }
        if (jsonObject.containsKey("DECHAL")){
            jsonObject.put("dechal",jsonObject.getString("DECHAL"));
            jsonObject.remove("DECHAL");
        }
        if (jsonObject.containsKey("DOSE_VBM")){
            jsonObject.put("dose_vbm", jsonObject.getString("DOSE_VBM"));
            jsonObject.remove("DOSE_VBM");
        }
        if (jsonObject.containsKey("ROLE_COD")){
            jsonObject.put("role_cod", jsonObject.getString("ROLE_COD"));
            jsonObject.remove("ROLE_COD");
        }
        if (jsonObject.containsKey("RECHAL")){
            jsonObject.put("rechal", jsonObject.getString("RECHAL"));
            jsonObject.remove("RECHAL");
        }
        if (jsonObject.containsKey("DRUGNAME")){
            jsonObject.put("drugname", jsonObject.getString("DRUGNAME"));
            jsonObject.remove("DRUGNAME");
        }
        if (jsonObject.containsKey("VAL_VBM")){
            jsonObject.put("val_vbm", jsonObject.getString("VAL_VBM"));
            jsonObject.remove("VAL_VBM");
        }
        if (jsonObject.containsKey("NDA_NUM")){
            jsonObject.put("nda_num", jsonObject.getString("NDA_NUM"));
            jsonObject.remove("NDA_NUM");
        }

        if (jsonObject.containsKey("DRUG_SEQ")){
            jsonObject.put("drug_seq",jsonObject.getString("DRUG_SEQ"));
            jsonObject.remove("DRUG_SEQ");
        }
        if (jsonObject.containsKey("LOT_NUM")){
            jsonObject.put("lot_num", jsonObject.getString("LOT_NUM"));
            jsonObject.remove("LOT_NUM");
        }
        if (jsonObject.containsKey("EXP_DT")){
            jsonObject.put("exp_dt",jsonObject.getString("EXP_DT"));
            jsonObject.remove("EXP_DT");
        }

        FearsChooseImpl.convertKeysToLowerCase(jsonObject);
    }

    /**
     * 获取指定集合中的主键集合
     */
    private HashSet<String> getPrimaryIds(String collectionName) {
        List<JSONObject> records = mongoUtil.mongo.findAll(JSONObject.class, collectionName);
        return records.stream()
                .map(jsonObject -> {
                            String primaryId = jsonObject.getString("primaryid");
                            return (primaryId != null && !primaryId.isEmpty()) ? primaryId : jsonObject.getString("ISR");
                        }
                )
                .collect(Collectors.toCollection(HashSet::new));
    }






    /**
     * 将 JSON 对象中的所有键转换为小写（递归处理嵌套结构）
     */
    public static Object convertKeysToLowerCase(JSONObject obj) {

            // 处理 JSON 对象
            JSONObject jsonObject = obj;
            JSONObject newJsonObject = new JSONObject();
            for (String key : jsonObject.keySet()) {
                Object value = jsonObject.get(key);
                // 键转换为小写，递归处理值
                newJsonObject.put(key.toLowerCase(), value);
            }
            return newJsonObject;

    }




    /**
     * 导出 MongoDB 数据库的所有集合数据为 Excel 文件
     */
    public void exportDatabaseToExcel(String databaseName, String outputFilePath) {
        try (Workbook workbook = new XSSFWorkbook()) {
            // 获取数据库中的所有集合名称

                // 创建一个新的工作表
                Sheet sheet = workbook.createSheet(databaseName);

                // 查询集合中的所有文档
                List<JSONObject> documents = mongoUtil.mongo.findAll(JSONObject.class, databaseName);

                if (!documents.isEmpty()) {
                    // 写入表头（字段名）
                    Row headerRow = sheet.createRow(0);
                    JSONObject firstDocument = documents.get(0);
                    int colIndex = 0;
                    for (String key : firstDocument.keySet()) {
                        Cell cell = headerRow.createCell(colIndex++);
                        cell.setCellValue(key);
                    }

                    // 写入数据行
                    int rowIndex = 1;
                    for (JSONObject document : documents) {
                        Row dataRow = sheet.createRow(rowIndex++);
                        colIndex = 0;
                        for (String key : firstDocument.keySet()) {
                            Cell cell = dataRow.createCell(colIndex++);
                            Object value = document.get(key);
                            cell.setCellValue(value != null ? value.toString() : "");
                        }
                    }

            }

            // 将工作簿写入文件
            try (FileOutputStream fileOut = new FileOutputStream(outputFilePath)) {
                workbook.write(fileOut);
            }

            System.out.println("Excel 文件已成功导出: " + outputFilePath);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }



    @Async
    @Override
    public void getDemo(String databaseName) {
        String[] split = databaseName.split(",");
        List<String> drugs = Arrays.asList(split);
        String drugName = drugs.get(0);

        // 构建药品搜索的正则表达式
        String drugRegex = drugs.stream()
                .map(Pattern::quote)
                .reduce((a, b) -> a + "|" + b)
                .orElse("");

        for (int year = 2004; year <= 2025; year++) {
            for (int month = 1; month <= 4; month++) {
                String quarterTable = String.valueOf(year).substring(2, 4) + "Q" + month;

                ArrayList<AdverseIndex> adverseIndices = new ArrayList<>();
                ArrayList<AdverseForCaseIndex> adverseForCaseIndices = new ArrayList<>();

                // 查询条件构建
                Criteria drugSearchCriteria = buildDrugSearchCriteria(drugRegex);
                Query query = new Query(drugSearchCriteria);

//                 分页处理药品数据
              
                List<JSONObject> batchRecords = mongoUtil.mongo.find(query, JSONObject.class, "DRUG" + quarterTable);


//                // 获取主键集合
                HashSet<String> primaryIds = new HashSet<>();
                HashSet<Long> primaryIdsInt = new HashSet<>();

                
                if (CollUtil.isNotEmpty(batchRecords)) {
                    for (JSONObject batchRecord : batchRecords) {
                        String primaryId = batchRecord.getString("primaryid");
                        primaryId =  (primaryId != null && !primaryId.isEmpty()) ? primaryId : batchRecord.getString("ISR");
                        primaryIds.add(primaryId);
                        if (StringUtils.isEmpty(primaryId)) {
                            continue;
                        }
                        primaryIdsInt.add(Long.parseLong(primaryId));
                    }
                    
                }

                log.info("数量为:{}",primaryIds.size());


                Criteria criteria = new Criteria();
                criteria.orOperator(
                        Criteria.where("primaryid").in(primaryIds),
                        Criteria.where("primaryid").in(primaryIdsInt)
                );


                List<JSONObject> results = mongoUtil.mongo.find(new Query(criteria), JSONObject.class, "DEMOOnly" + year);

                ArrayList<Long> longs = new ArrayList<>();


                for (JSONObject result : results) {
                    String caseid = result.getString("caseid");
                    String primaryid = result.getString("primaryid");
                    Criteria criteria1 = new Criteria();
                    criteria1.orOperator(
                            Criteria.where("ISR").is(primaryid),
                            Criteria.where("primaryid").is(primaryid),
                            Criteria.where("ISR").is(Long.parseLong(primaryid)),
                            Criteria.where("primaryid").is(Long.parseLong(primaryid))
                    );

                    String table = result.getString("table");

                    longs.add(Long.parseLong(caseid));



                    Criteria criteria2 = new Criteria().andOperator(criteria1, drugSearchCriteria);

                    Query queryx = new Query(criteria1);
                    //查询药品相关
                    List<JSONObject> jsonObjects1 = mongoUtil.mongo.find(new Query(criteria2), JSONObject.class, "DRUG" + table);



                    //不良反应相关
                    List<JSONObject> jsonObjectsReac = mongoUtil.mongo.find(queryx, JSONObject.class, "REAC" + table);


                    //组装
                    String id = UUID.randomUUID().toString();
                    AdverseIndex adverseIndex = new AdverseIndex();
                    adverseIndex.setId(id);

                    adverseIndex.setCaseId(Long.parseLong(caseid));

                    adverseIndex.setPrId(Long.parseLong(primaryid));

                    //所有不良反应
                    ArrayList<String> strings = new ArrayList<>();
                    for (JSONObject jsonObject : jsonObjectsReac) {
                        String pt = jsonObject.getString("pt");
                        if (StringUtils.isBlank(pt)) {
                            pt = jsonObject.getString("PT");
                        }
                        if (StringUtils.isNotEmpty(pt)) {
                            pt = pt.toLowerCase();
                        } else {
                            pt = "";
                        }
                        strings.add(pt);
                    }
                    long ptListNum = strings.size();
                    adverseIndex.setPtList(strings);

                    String target = "Pancreatitis";

                    boolean containsTarget = strings.stream()
                            .anyMatch(element -> element.toLowerCase().contains(target.toLowerCase()));

                    if (!containsTarget) {
                        continue;
                    }


                    //年龄  直接需要划分区间
                    String age = result.getString("AGE");
                    if (StringUtils.isEmpty(age)) {
                        age = result.getString("age");
                    }
                    String ageCode = result.getString("AGE_COD");
                    if (StringUtils.isEmpty(ageCode)) {
                        ageCode = result.getString("age_cod");
                    }
                    adverseIndex.setAge(ageConvert(age, ageCode));

                    //性别
                    String sex = result.getString("GNDR_COD");
                    if (StringUtils.isEmpty(sex)) {
                        sex = result.getString("sex");
                    }
                    if ("F".equals(sex)) {
                        sex = "女";
                    } else if ("M".equals(sex)) {
                        sex = "男";
                    } else {
                        sex = "未知";
                    }
                    adverseIndex.setSex(sex);

                    //上报者职业
                    String string = result.getString("OCCP_COD");
                    if (StringUtils.isEmpty(string)) {
                        string = result.getString("occp_cod");
                    }
                    adverseIndex.setOccupationalCod(getOccupationalCod(string));

                    //严重不良反应结局
                    List<JSONObject> jsonObjectsOUTC = mongoUtil.mongo.find(queryx, JSONObject.class, "OUTC" + table);


                    ArrayList<String> strings1 = new ArrayList<>();
                    for (JSONObject jsonObject : jsonObjectsOUTC) {
                        String string1 = jsonObject.getString("OUTC_COD");
                        if (StringUtils.isEmpty(string1)) {
                            string1 = jsonObject.getString("outc_cod");
                        }
                        if (StringUtils.isNotEmpty(string1)) {
                            strings1.add(string1);
                        }
                    }
                    adverseIndex.setOutcomeCod(getOUTC(strings1));

                    //时间
                    String date = result.getString("FDA_DT");
                    if (StringUtils.isEmpty(date)) {
                        date = result.getString("fda_dt");
                    }
                    adverseIndex.setDate(Integer.valueOf(date));

                    //严重不良反应结局总数
                    long outcomeCodNum = strings1.size();
                    adverseIndex.setOutcomeCodNum(outcomeCodNum);

                    //体重分布
                    String weight = result.getString("WT");
                    if (StringUtils.isEmpty(weight)) {
                        weight = result.getString("wt");
                    }
                    String weightCode = result.getString("WT_COD");
                    if (StringUtils.isEmpty(weightCode)) {
                        weightCode = result.getString("wt_cod");
                    }
                    adverseIndex.setWeight(weightConvert(weight, weightCode));

                    //地区分布
                    String reporterCountry = result.getString("REPORTER_COUNTRY");
                    if (StringUtils.isEmpty(reporterCountry)) {
                        reporterCountry = result.getString("reporter_country");
                    }
                    if (StringUtils.isNotEmpty(reporterCountry)) {
                        String s = COUNTRY_CONTINENT_MAP.get(reporterCountry);
                        if (StringUtils.isNotEmpty(s)) {
                            adverseIndex.setReporterCountry(s);
                        } else {
                            adverseIndex.setReporterCountry("未知");
                        }

                        String s1 = COUNTRY_NAME_MAP.get(reporterCountry);
                        if (StringUtils.isNotEmpty(s1)) {
                            adverseIndex.setReporterCountryName(s1);
                        } else {
                            adverseIndex.setReporterCountryName("未知");
                        }
                    }

                    //获取药品名称
                    ArrayList<String> drugNames = new ArrayList<>();
                    ArrayList<String> prod_ais = new ArrayList<>();
                    ArrayList<String> roleCods = new ArrayList<>();
                    List<RoleCod> realRoleCods = new ArrayList<>();
                    //用法
                    ArrayList<String> route = new ArrayList<>();
                    adverseIndex.setRoute(route);
                    //用量
                    ArrayList<String> doseAmtCombine = new ArrayList<>();
                    adverseIndex.setDoseAmtCombine(doseAmtCombine);
                    //剂型
                    ArrayList<String> doseForm = new ArrayList<>();
                    adverseIndex.setDoseForm(doseForm);
                    //适应症
                    ArrayList<String> indicationPt = new ArrayList<>();

                    adverseIndex.setSingleDrug(jsonObjects1.size() > 1 ? false : true);

                    adverseIndex.setYear(Integer.valueOf(year));

                    List<JSONObject> jsonObjects = mongoUtil.mongo.find(queryx, JSONObject.class, "THER" + table);
                    List<JSONObject> jsonObjects8 = mongoUtil.mongo.find(queryx, JSONObject.class, "INDI" + table);

                    Criteria criteria3 = new Criteria();
                    criteria3.orOperator(
                            Criteria.where("ISR").is(primaryid),
                            Criteria.where("primaryid").is(primaryid),
                            Criteria.where("ISR").is(Long.parseLong(primaryid)),
                            Criteria.where("primaryid").is(Long.parseLong(primaryid))
                    );

                    if (CollUtil.isNotEmpty(jsonObjects1)) {
                        jsonObjects1 = mongoUtil.mongo.find(new Query(criteria3), JSONObject.class, "DRUG" + table);
                    }

                    boolean has = false;
                    //药品相关
                    for (JSONObject jsonObject : jsonObjects1) {
                        
                        

                        AdverseForCaseIndex adverseForCaseIndex = new AdverseForCaseIndex();

                        adverseForCaseIndex.setCaseId(Long.parseLong(caseid));

                        adverseForCaseIndex.setPrId(Long.parseLong(primaryid));

                        adverseForCaseIndex.setYear(Integer.valueOf(year));

                        String drug_name = jsonObject.getString("DRUGNAME");
                        if (StringUtils.isEmpty(drug_name)) {
                            drug_name = jsonObject.getString("drugname");
                        }
                        if (StringUtils.isNotEmpty(drug_name)) {
                            drug_name = drug_name.toLowerCase();
                        } else {
                            drug_name = "";
                        }
                        
                        

                        drugNames.add(drug_name);
                        adverseForCaseIndex.setDrugName(drug_name);
                        String prod_ai = jsonObject.getString("prod_ai");
                        if (StringUtils.isEmpty(prod_ai)) {
                            prod_ai = jsonObject.getString("PROD_AI");
                        }
                        if (StringUtils.isNotEmpty(prod_ai)) {
                            prod_ai = prod_ai.toLowerCase();
                        } else {
                            prod_ai = "";
                        }

                        prod_ais.add(prod_ai);
                        String role_cod = jsonObject.getString("role_cod");
                        if (StringUtils.isEmpty(role_cod)) {
                            role_cod = jsonObject.getString("ROLE_COD");
                        }



                        //适配之前数据
                        roleCods.add(drug_name + "￥" + prod_ai + "￥" + role_cod);
                        adverseForCaseIndex.setRoleCod(role_cod);

                        //储存一个对象的格式
                        RoleCod roleCod1 = new RoleCod();
                        roleCod1.setDrug(drug_name);
                        roleCod1.setProdAi(prod_ai);
                        roleCod1.setRole(role_cod);

                        //获取其他属相
                        String rechal = jsonObject.getString("rechal");
                        if (StringUtils.isEmpty(rechal)) {
                            rechal = jsonObject.getString("RECHAL");
                        }
                        roleCod1.setRechal(rechal);
                        adverseForCaseIndex.setRechal(rechal);

                        String dechal = jsonObject.getString("dechal");
                        if (StringUtils.isEmpty(dechal)) {
                            dechal = jsonObject.getString("DECHAL");
                        }
                        roleCod1.setDechal(dechal);
                        adverseForCaseIndex.setDechal(dechal);

                        //治疗持续时间分布
                        String drug_seq = jsonObject.getString("DRUG_SEQ");
                        if (StringUtils.isEmpty(drug_seq)) {
                            drug_seq = jsonObject.getString("drug_seq");
                        }




                        if (jsonObjects.size() > 0) {

                            JSONObject jsonObject1 = null;
                            for (JSONObject object : jsonObjects) {
                                if (drug_seq.equals(object.getString("DRUG_SEQ"))||drug_seq.equals(object.getString("dsg_drug_seq"))) {
                                    jsonObject1 = object;
                                }
                            }
                            if (jsonObject1 != null){


                                String eventDt = result.getString("EVENT_DT");
                                if (StringUtils.isEmpty(eventDt)) {
                                    eventDt = result.getString("event_dt");
                                }



                                //获取4位6位8位数时间，计算天数
                                String startDt = jsonObject1.getString("START_DT");
                                if (StringUtils.isEmpty(startDt)) {
                                    startDt = jsonObject1.getString("start_dt");
                                }
                                String endDt = jsonObject1.getString("END_DT");
                                if (StringUtils.isEmpty(endDt)) {
                                    endDt = jsonObject1.getString("end_dt");
                                }
                                if (StringUtils.isNotEmpty(startDt) && StringUtils.isNotEmpty(endDt)) {

                                    try {
                                        //不够8位先补全8位时间数  默认一月一日
                                        // 不够8位先补全8位时间数，结束时间补到最后一天
                                        if (endDt.length() == 4) {
                                            // 补全年份的最后一天：2021 → 20211231
                                            endDt = endDt + "1231";
                                        } else if (endDt.length() == 6) {
                                            // 补全到当月的最后一天：202105 → 20210531
                                            String yearx = endDt.substring(0, 4);
                                            String monthx = endDt.substring(4, 6);
                                            int yearInt = Integer.parseInt(yearx);
                                            int monthInt = Integer.parseInt(monthx);
                                            // 获取该月最后一天
                                            LocalDate lastDay = LocalDate.of(yearInt, monthInt, 1).withDayOfMonth(
                                                    LocalDate.of(yearInt, monthInt, 1).lengthOfMonth()
                                            );
                                            endDt = lastDay.format(DateTimeFormatter.BASIC_ISO_DATE);
                                        }
                                        if (startDt.length() == 4) {
                                            startDt = startDt + "0101";
                                        }
                                        if (startDt.length() == 6) {
                                            startDt = startDt + "01";
                                        }

                                        //算时间差的天数
                                        DateTimeFormatter formatter = new DateTimeFormatterBuilder()
                                                .appendPattern("yyyyMMdd")
                                                .parseStrict() // 严格模式，拒绝不匹配的输入
                                                .toFormatter();
                                        LocalDate date1 = LocalDate.parse(startDt, formatter);
                                        LocalDate date2 = LocalDate.parse(endDt, formatter);
                                        long daysBetween = ChronoUnit.DAYS.between(date1, date2) + 1;
                                        roleCod1.setDur(String.valueOf(daysBetween) + "days");
                                        adverseIndex.setDur(String.valueOf(daysBetween) + "days");
                                        adverseForCaseIndex.setDur(String.valueOf(daysBetween) + "days");
                                    } catch (Exception e) {
                                        roleCod1.setDur("unknown");
                                        adverseIndex.setDur("unknown");
                                        adverseForCaseIndex.setDur("unknown");
                                    }
                                } else {
                                    roleCod1.setDur("unknown");
                                    adverseIndex.setDur("unknown");
                                    adverseForCaseIndex.setDur("unknown");
                                }

                                if (StringUtils.isNotEmpty(eventDt) && StringUtils.isNotEmpty(startDt)) {

                                    try {
                                        //不够8位先补全8位时间数  默认一月一日
                                        if (startDt.length() == 4) {
                                            startDt = startDt + "0101";
                                        }
                                        if (startDt.length() == 6) {
                                            startDt = startDt + "01";
                                        }
                                        if (eventDt.length() == 4) {
                                            // 补全年份的最后一天：2021 → 20211231
                                            eventDt = eventDt + "1231";
                                        } else if (eventDt.length() == 6) {
                                            // 补全到当月的最后一天：202105 → 20210531
                                            String yearx = eventDt.substring(0, 4);
                                            String monthx = eventDt.substring(4, 6);
                                            int yearInt = Integer.parseInt(yearx);
                                            int monthInt = Integer.parseInt(monthx);
                                            // 获取该月最后一天
                                            LocalDate lastDay = LocalDate.of(yearInt, monthInt, 1).withDayOfMonth(
                                                    LocalDate.of(yearInt, monthInt, 1).lengthOfMonth()
                                            );
                                            eventDt = lastDay.format(DateTimeFormatter.BASIC_ISO_DATE);
                                        }

                                        //算时间差的天数
                                        DateTimeFormatter formatter = new DateTimeFormatterBuilder()
                                                .appendPattern("yyyyMMdd")
                                                .parseStrict() // 严格模式，拒绝不匹配的输入
                                                .toFormatter();
                                        LocalDate date1 = LocalDate.parse(eventDt, formatter);
                                        LocalDate date2 = LocalDate.parse(startDt, formatter);
                                        long daysBetween = ChronoUnit.DAYS.between(date2, date1) + 1;
                                        roleCod1.setReactionOfTime(String.valueOf(daysBetween) + "days");
                                        adverseIndex.setReactionOfTime(String.valueOf(daysBetween) + "days");
                                        adverseForCaseIndex.setReactionOfTime(String.valueOf(daysBetween) + "days");
                                    } catch (Exception e) {
                                        roleCod1.setReactionOfTime("unknown");
                                        adverseIndex.setReactionOfTime("unknown");
                                        adverseForCaseIndex.setReactionOfTime("unknown");
                                    }
                                } else {
                                    roleCod1.setReactionOfTime("unknown");
                                    adverseIndex.setReactionOfTime("unknown");
                                    adverseForCaseIndex.setReactionOfTime("unknown");
                                }
                            }
                        } else {
                            roleCod1.setDur("unknown");
                            adverseIndex.setDur("unknown");
                            adverseForCaseIndex.setDur("unknown");
                            roleCod1.setReactionOfTime("unknown");
                            adverseIndex.setReactionOfTime("unknown");
                            adverseForCaseIndex.setReactionOfTime("unknown");
                        }

                        //用法
                        String route1 = jsonObject.getString("ROUTE");
                        if (StringUtils.isEmpty(route1)) {
                            route1 = jsonObject.getString("route");
                        }

                        if (StringUtils.isNotEmpty(route1)) {
                            route1 = route1.toLowerCase();
                        } else {
                            route1 = "unknown";
                        }
                        route.add(route1);
                        adverseForCaseIndex.setRoute(route1);

                        //剂量
                        String doseAmtCombine1 = jsonObject.getString("dose_amt") + jsonObject.getString("dose_unit");
                        if (StringUtils.isEmpty(jsonObject.getString("dose_amt")) || StringUtils.isEmpty(jsonObject.getString("dose_unit"))) {
                            doseAmtCombine1 = "unknown";
                        }
                        doseAmtCombine.add(doseAmtCombine1);
                        adverseForCaseIndex.setDoseAmtCombine(doseAmtCombine1);

                        String doseForm1 = jsonObject.getString("dose_form");
                        if (StringUtils.isEmpty(doseForm1)) {
                            doseForm1 = "unknown";
                        }
                        doseForm.add(doseForm1);
                        adverseForCaseIndex.setDoseForm(doseForm1);

                        //开始查询适应症



                        if (CollUtil.isNotEmpty(jsonObjects8)) {
                            JSONObject object = null;
                            for (JSONObject jsonObject1 : jsonObjects8) {
                                if (drug_seq.equals(jsonObject1.getString("DRUG_SEQ"))||drug_seq.equals(jsonObject1.getString("indi_drug_seq"))){
                                    object = jsonObject1;
                                }
                            }
                            if (object != null) {

                                String stringx = object.getString("INDI_PT");
                                if (StringUtils.isEmpty(stringx)) {
                                    stringx = object.getString("indi_pt");
                                }

                                if (StringUtils.isNotEmpty(stringx)) {
                                    stringx = stringx.toLowerCase();
                                } else {
                                    stringx = "";
                                }

                                indicationPt.add(stringx);
                                adverseForCaseIndex.setIndicationPt(stringx);
                            }
                        }

                        //不良反应
                        adverseForCaseIndex.setPtList(strings);

                        //不良反应数量
                        adverseForCaseIndex.setPtListNum(ptListNum);

                        //不良反应结局
                        adverseForCaseIndex.setOutcomeCod(getOUTC(strings1));

                        //结果数量
                        adverseForCaseIndex.setOutcomeCodNum(outcomeCodNum);

                        //所属地区
                        adverseForCaseIndex.setReporterCountry(adverseIndex.getReporterCountry());

                        //上报职业
                        adverseForCaseIndex.setOccupationalCod(getOccupationalCod(string));

                        //性别
                        adverseForCaseIndex.setSex(adverseIndex.getSex());

                        //年龄
                        adverseForCaseIndex.setAge(ageConvert(age, ageCode));

                        //体重
                        adverseForCaseIndex.setWeight(weightConvert(weight, weightCode));

                        //上报日期
                        adverseForCaseIndex.setDate(Integer.valueOf(date));
                        realRoleCods.add(roleCod1);

                        adverseForCaseIndices.add(adverseForCaseIndex);
                        has = true;

                    }
                    adverseIndex.setRoleCods(realRoleCods);
                    adverseIndex.setDrugName(drugNames);
                    adverseIndex.setProdAi(prod_ais);
                    adverseIndex.setRoleCod(roleCods);
                    adverseIndex.setIndicationPt(indicationPt);


                    //不良反应总数
                    adverseIndex.setPtListNum(ptListNum);

                    if (has){
                        adverseIndices.add(adverseIndex);

                    }


                }
                

                if (CollUtil.isNotEmpty(adverseIndices)) {
                    mongoUtil.mongo.remove(new Query(Criteria.where("caseId").in(longs)),"quchong_wanzheng_pt_" + drugName);
                    mongoUtil.mongo.remove(new Query(Criteria.where("caseId").in(longs)),"quchong_yaopin_pt_" + drugName);
                    mongoUtil.mongo.insert(adverseIndices, "quchong_wanzheng_pt_" + drugName);
                    mongoUtil.mongo.insert(adverseForCaseIndices, "quchong_yaopin_pt_" + drugName);

                    log.info("添加数量分别为{},{}",adverseIndices.size(),adverseForCaseIndices.size());

                }
                log.info("添加成功{}",year);


            }
        }
    }

    @Override
    public void  getPt(String databaseName) {

        String[] split = databaseName.split("、");
        for (String s : split) {
            List<JSONObject> jsonObjects = mongoUtil.mongo.find(new Query(), JSONObject.class, "ptList_" + s);
            long count1 = mongoUtil.mongo.count(new Query(), JSONObject.class, "quchong_wanzheng_" + s);
            jsonObjects.forEach(jsonObject -> {
                String id = jsonObject.getString("_id");
                List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("pt_en").is(id)), JSONObject.class, "pt_all_data");
                if (CollUtil.isNotEmpty(jsonObjects1)) {
                    jsonObject.put("organ", jsonObjects1.get(0).get("main_soc_organ"));
                }
                BigDecimal count = jsonObject.getBigDecimal("count");
                BigDecimal divide = count.divide(new BigDecimal(count1), 6, BigDecimal.ROUND_HALF_UP);
                divide = divide.multiply(new BigDecimal("100")).setScale(2, BigDecimal.ROUND_HALF_UP);
                jsonObject.put("accountFor", divide+"%");
                mongoUtil.mongo.save(jsonObject, "pt_ac_"+s);
            });
        }

    }


    private String weightConvert(String weight, String weightCode) {
        double i;
        try {
            i = Double.parseDouble(weight);
        } catch (Exception e) {
            return "未知";
        }

        if (StringUtils.isEmpty(weight) || StringUtils.isEmpty(weightCode)) {
            return "未知";
        }
        if ("KG".equals(weightCode)) {
            if (i < 50) {
                return "<50kg";
            }
            if (i >= 50 && i <= 100) {
                return "50~100kg";
            }
            if (i > 100) {
                return ">100kg";
            }
        }
        if ("LBS".equals(weightCode)) {
            if (i < 110) {
                return "<50kg";
            }
            if (i >= 110 && i <= 220) {
                return "50~100kg";
            }
            if (i > 220) {
                return ">100kg";
            }
        }
        return "未知";
    }

    private List<String> getOUTC(ArrayList<String> strings1) {
        if (CollUtil.isEmpty(strings1)) {
            ArrayList<String> strings = new ArrayList<String>();
            return strings;
        }
        ArrayList<String> strings = new ArrayList<>();
        if (strings1.contains("DE")) {
            strings.add("死亡");
            return strings;
        }
        if (strings1.contains("LT")) {
            strings.add("危及生命");
            return strings;
        }
        if (strings1.contains("DS")) {
            strings.add("残疾");
            return strings;
        }
        if (strings1.contains("CA")) {
            strings.add("先天性畸形");
            return strings;
        }
        if (strings1.contains("RI")) {
            strings.add("需要临床干预以防止永久性损伤/损坏");
            return strings;
        }
        if (strings1.contains("HO")) {
            strings.add("需要住院治疗或延长住院时间");
            return strings;
        }
        if (strings1.contains("OT")) {
            strings.add("其他重要的医学事件");
            return strings;
        }
        return strings;
    }

    private String getOccupationalCod(String string) {
        if (StringUtils.isEmpty(string)) {
            return "未知";
        }

        if (string.equals("MD")) {
            return "医生";
        }
        if (string.equals("PH")) {
            return "药剂师";
        }
        if (string.equals("OT")) {
            return "其他";
        }
        if (string.equals("LW")) {
            return "律师";
        }
        if (string.equals("CN")) {
            return "消费者";
        }
        return "未知";

    }


    //年龄转化
    private String ageConvert(String num, String unit) {
        double num1 = 0;
        try {
            num1 = Double.parseDouble(num);
        } catch (Exception e) {
            return "未知";
        }
        double age = 0;
        if (StringUtils.isEmpty(num) || StringUtils.isEmpty(unit)) {
            return "未知";
        }
        if (unit.equals("YR")) {
            age = num1;
        }
        if (unit.equals("DEC")) {
            age = num1 * 10;
        }
        if (unit.equals("MON")) {
            age = num1 / 12;
        }
        if (unit.equals("DAY")) {
            age = num1 / 365;
        }
        if (unit.equals("WK")) {
            age = num1 / 52;
        }
        if (unit.equals("HR")) {
            age = num1 / 8760;
        }
        if (age <= 18) {
            return "≤18岁";
        }
        if (age >= 65) {
            return "≥65岁";
        }
        if (age > 18 && age < 65) {
            return "18<年龄<65";
        }
        return "未知";
    }

    public static final Map<String, String> COUNTRY_CONTINENT_MAP = new HashMap<>();

    static {
        // 亚洲（Asia）
        COUNTRY_CONTINENT_MAP.put("AE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BD", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("GE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("HK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("ID", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IL", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KW", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LB", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("NP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PS", "亚洲");
        COUNTRY_CONTINENT_MAP.put("QA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TW", "亚洲");
        COUNTRY_CONTINENT_MAP.put("VN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BT", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JO", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KZ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MO", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MV", "亚洲");
        COUNTRY_CONTINENT_MAP.put("OM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SY", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TJ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("UZ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("YE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IQ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TL", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("XA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LAO PEOPLE'S DEMOCRATIC REPUBLIC", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CYPRUS", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MACAU", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KYRGYZSTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BRUNEI DARUSSALAM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BANGLADESH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SRI LANKA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BAHRAIN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("OMAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SYRIAN ARAB REPUBLIC", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AFGHANISTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("YEMEN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("QATAR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PALESTINIAN TERRITORY, OCCUPIED", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MONGOLIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MYANMAR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("ARMENIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AZERBAIJAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KAZAKHSTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IRAN (ISLAMIC REPUBLIC OF)", "亚洲");
        COUNTRY_CONTINENT_MAP.put("INDONESIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PAKISTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("THAILAND", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PHILIPPINES", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SINGAPORE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LEBANON", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KOREA, REPUBLIC OF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("UNITED ARAB EMIRATES", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KUWAIT", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SAUDI ARABIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CAMBODIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JORDAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("HONG KONG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CHINA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TAIWAN, PROVINCE OF CHINA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TF", "欧洲"); // 原数据标注为欧洲（实际属南极洲，此处按原数据保留）
        COUNTRY_CONTINENT_MAP.put("GG", "Oceania"); // 原数据标注为大洋洲，保留原始值
        COUNTRY_CONTINENT_MAP.put("TF", "欧洲"); // 重复键按原数据最后出现值处理

        // 欧洲（Europe）
        COUNTRY_CONTINENT_MAP.put("AT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BG", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CH", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CZ", "欧洲");
        COUNTRY_CONTINENT_MAP.put("DE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("DK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ES", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GB", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LV", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("UA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AD", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("EE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("XE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MC", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MD", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ME", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("XK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("JE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("VA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("YU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ALAND ISLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ML", "非洲"); // 原数据中ML在非洲，此处避免重复
        COUNTRY_CONTINENT_MAP.put("ITALY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRANCE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GERMANY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SWITZERLAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NETHERLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SPAIN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IRELAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("TURKEY", "Asia"); // 原数据部分标注为亚洲，按原始值保留
        COUNTRY_CONTINENT_MAP.put("CROATIA (LOCAL NAME: HRVATSKA)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RUSSIAN FEDERATION", "欧洲");
        COUNTRY_CONTINENT_MAP.put("POLAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BELGIUM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HUNGARY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GREECE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SWEDEN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PORTUGAL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AUSTRIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NORWAY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BELARUS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BULGARIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CZECH REPUBLIC", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LITHUANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ROMANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SLOVENIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LUXEMBOURG", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ESTONIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LATVIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MALTA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SLOVAKIA (SLOVAK REPUBLIC)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ALBANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ICELAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MONACO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MONTENEGRO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("VATICAN CITY STATE (HOLY SEE)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("EUROPEAN UNION", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NETHERLANDS ANTILLES (RETIRED CODE)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SERBIA AND MONTENEGRO (SEE INDIVIDUAL COUNTRIES)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("YUGOSLAVIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRENCH SOUTHERN TERRITORIES", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FAROE ISLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ISLE OF MAN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRANCE, METROPOLITAN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SERBIA AND MONTENEGRO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BOSNIA AND HERZEGOWINA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GIBRALTAR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GUadeloupe", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MARTINIQUE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MF", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RE", "欧洲");

        // 非洲（Africa）
        COUNTRY_CONTINENT_MAP.put("EG", "非洲");
        COUNTRY_CONTINENT_MAP.put("GA", "非洲");
        COUNTRY_CONTINENT_MAP.put("GH", "非洲");
        COUNTRY_CONTINENT_MAP.put("KE", "非洲");
        COUNTRY_CONTINENT_MAP.put("LS", "非洲");
        COUNTRY_CONTINENT_MAP.put("MA", "非洲");
        COUNTRY_CONTINENT_MAP.put("MW", "非洲");
        COUNTRY_CONTINENT_MAP.put("NG", "非洲");
        COUNTRY_CONTINENT_MAP.put("RW", "非洲");
        COUNTRY_CONTINENT_MAP.put("TZ", "非洲");
        COUNTRY_CONTINENT_MAP.put("UG", "非洲");
        COUNTRY_CONTINENT_MAP.put("ZA", "非洲");
        COUNTRY_CONTINENT_MAP.put("ZW", "非洲");
        COUNTRY_CONTINENT_MAP.put("DZ", "North America"); // 原数据标注为北美洲（阿尔及利亚属非洲，此处按原数据保留）
        COUNTRY_CONTINENT_MAP.put("AO", "非洲");
        COUNTRY_CONTINENT_MAP.put("BF", "非洲");
        COUNTRY_CONTINENT_MAP.put("BI", "非洲");
        COUNTRY_CONTINENT_MAP.put("BJ", "非洲");
        COUNTRY_CONTINENT_MAP.put("BW", "非洲");
    }


    public static final Map<String, String> COUNTRY_NAME_MAP = new HashMap<>();

    static {
        // 亚洲国家
        COUNTRY_NAME_MAP.put("AE", "阿拉伯联合酋长国");
        COUNTRY_NAME_MAP.put("BD", "孟加拉国");
        COUNTRY_NAME_MAP.put("CN", "中国");
        COUNTRY_NAME_MAP.put("GE", "格鲁吉亚");
        COUNTRY_NAME_MAP.put("HK", "中国香港特别行政区");
        COUNTRY_NAME_MAP.put("ID", "印度尼西亚");
        COUNTRY_NAME_MAP.put("IL", "以色列");
        COUNTRY_NAME_MAP.put("IN", "印度");
        COUNTRY_NAME_MAP.put("IR", "伊朗");
        COUNTRY_NAME_MAP.put("JP", "日本");
        COUNTRY_NAME_MAP.put("KR", "韩国");
        COUNTRY_NAME_MAP.put("KW", "科威特");
        COUNTRY_NAME_MAP.put("LB", "黎巴嫩");
        COUNTRY_NAME_MAP.put("MM", "缅甸");
        COUNTRY_NAME_MAP.put("MY", "马来西亚");
        COUNTRY_NAME_MAP.put("NP", "尼泊尔");
        COUNTRY_NAME_MAP.put("PH", "菲律宾");
        COUNTRY_NAME_MAP.put("PK", "巴基斯坦");
        COUNTRY_NAME_MAP.put("PS", "巴勒斯坦");
        COUNTRY_NAME_MAP.put("QA", "卡塔尔");
        COUNTRY_NAME_MAP.put("SA", "沙特阿拉伯");
        COUNTRY_NAME_MAP.put("SG", "新加坡");
        COUNTRY_NAME_MAP.put("SY", "叙利亚");
        COUNTRY_NAME_MAP.put("TH", "泰国");
        COUNTRY_NAME_MAP.put("TR", "土耳其");
        COUNTRY_NAME_MAP.put("TW", "中国台湾地区");
        COUNTRY_NAME_MAP.put("VN", "越南");
        COUNTRY_NAME_MAP.put("AF", "阿富汗");
        COUNTRY_NAME_MAP.put("AZ", "阿塞拜疆");
        COUNTRY_NAME_MAP.put("BN", "文莱");
        COUNTRY_NAME_MAP.put("KH", "柬埔寨");
        COUNTRY_NAME_MAP.put("KZ", "哈萨克斯坦");
        COUNTRY_NAME_MAP.put("LA", "老挝");
        COUNTRY_NAME_MAP.put("LK", "斯里兰卡");
        COUNTRY_NAME_MAP.put("OM", "阿曼");
        COUNTRY_NAME_MAP.put("TJ", "塔吉克斯坦");
        COUNTRY_NAME_MAP.put("TL", "东帝汶");
        COUNTRY_NAME_MAP.put("UZ", "乌兹别克斯坦");
        COUNTRY_NAME_MAP.put("YE", "也门");
        COUNTRY_NAME_MAP.put("AM", "亚美尼亚");
        COUNTRY_NAME_MAP.put("MO", "中国澳门特别行政区");
        COUNTRY_NAME_MAP.put("MN", "蒙古");
        COUNTRY_NAME_MAP.put("MV", "马尔代夫");
        COUNTRY_NAME_MAP.put("BT", "不丹");
        COUNTRY_NAME_MAP.put("TM", "土库曼斯坦");

        // 欧洲国家
        COUNTRY_NAME_MAP.put("AT", "奥地利");
        COUNTRY_NAME_MAP.put("BE", "比利时");
        COUNTRY_NAME_MAP.put("BG", "保加利亚");
        COUNTRY_NAME_MAP.put("CH", "瑞士");
        COUNTRY_NAME_MAP.put("CY", "塞浦路斯");
        COUNTRY_NAME_MAP.put("CZ", "捷克");
        COUNTRY_NAME_MAP.put("DE", "德国");
        COUNTRY_NAME_MAP.put("DK", "丹麦");
        COUNTRY_NAME_MAP.put("EE", "爱沙尼亚");
        COUNTRY_NAME_MAP.put("ES", "西班牙");
        COUNTRY_NAME_MAP.put("FI", "芬兰");
        COUNTRY_NAME_MAP.put("FR", "法国");
        COUNTRY_NAME_MAP.put("GB", "英国");
        COUNTRY_NAME_MAP.put("GR", "希腊");
        COUNTRY_NAME_MAP.put("HU", "匈牙利");
        COUNTRY_NAME_MAP.put("IE", "爱尔兰");
        COUNTRY_NAME_MAP.put("IT", "意大利");
        COUNTRY_NAME_MAP.put("LT", "立陶宛");
        COUNTRY_NAME_MAP.put("LU", "卢森堡");
        COUNTRY_NAME_MAP.put("LV", "拉脱维亚");
        COUNTRY_NAME_MAP.put("ME", "黑山");
        COUNTRY_NAME_MAP.put("MT", "马耳他");
        COUNTRY_NAME_MAP.put("NL", "荷兰");
        COUNTRY_NAME_MAP.put("NO", "挪威");
        COUNTRY_NAME_MAP.put("PL", "波兰");
        COUNTRY_NAME_MAP.put("PT", "葡萄牙");
        COUNTRY_NAME_MAP.put("RO", "罗马尼亚");
        COUNTRY_NAME_MAP.put("RS", "塞尔维亚");
        COUNTRY_NAME_MAP.put("RU", "俄罗斯");
        COUNTRY_NAME_MAP.put("SE", "瑞典");
        COUNTRY_NAME_MAP.put("SI", "斯洛文尼亚");
        COUNTRY_NAME_MAP.put("SK", "斯洛伐克");
        COUNTRY_NAME_MAP.put("UA", "乌克兰");
        COUNTRY_NAME_MAP.put("AL", "阿尔巴尼亚");
        COUNTRY_NAME_MAP.put("BA", "波斯尼亚和黑塞哥维那");
        COUNTRY_NAME_MAP.put("HR", "克罗地亚");
        COUNTRY_NAME_MAP.put("IS", "冰岛");
        COUNTRY_NAME_MAP.put("MK", "北马其顿");
        COUNTRY_NAME_MAP.put("IM", "马恩岛");
        COUNTRY_NAME_MAP.put("MC", "摩纳哥");
        COUNTRY_NAME_MAP.put("MD", "摩尔多瓦");
        COUNTRY_NAME_MAP.put("SM", "圣马力诺");
        COUNTRY_NAME_MAP.put("VA", "梵蒂冈");
        COUNTRY_NAME_MAP.put("XK", "科索沃"); // 部分国家承认
        COUNTRY_NAME_MAP.put("BY", "白俄罗斯");
        COUNTRY_NAME_MAP.put("GI", "直布罗陀");
        COUNTRY_NAME_MAP.put("FO", "法罗群岛");
        COUNTRY_NAME_MAP.put("AX", "奥兰群岛");
        COUNTRY_NAME_MAP.put("JE", "泽西岛");
        COUNTRY_NAME_MAP.put("GG", "根西岛");
        COUNTRY_NAME_MAP.put("LI", "列支敦士登");
        COUNTRY_NAME_MAP.put("SJ", "斯瓦尔巴群岛");
        COUNTRY_NAME_MAP.put("YU", "南斯拉夫"); // 已解体

        // 北美洲国家
        COUNTRY_NAME_MAP.put("CA", "加拿大");
        COUNTRY_NAME_MAP.put("CR", "哥斯达黎加");
        COUNTRY_NAME_MAP.put("DO", "多米尼加共和国");
        COUNTRY_NAME_MAP.put("GT", "危地马拉");
        COUNTRY_NAME_MAP.put("HN", "洪都拉斯");
        COUNTRY_NAME_MAP.put("HT", "海地");
        COUNTRY_NAME_MAP.put("JM", "牙买加");
        COUNTRY_NAME_MAP.put("MX", "墨西哥");
        COUNTRY_NAME_MAP.put("PA", "巴拿马");
        COUNTRY_NAME_MAP.put("PR", "波多黎各");
        COUNTRY_NAME_MAP.put("US", "美国");
        COUNTRY_NAME_MAP.put("AG", "安提瓜和巴布达");
        COUNTRY_NAME_MAP.put("BS", "巴哈马");
        COUNTRY_NAME_MAP.put("BB", "巴巴多斯");
        COUNTRY_NAME_MAP.put("CU", "古巴");
        COUNTRY_NAME_MAP.put("DM", "多米尼克");
        COUNTRY_NAME_MAP.put("GD", "格林纳达");
        COUNTRY_NAME_MAP.put("KN", "圣基茨和尼维斯");
        COUNTRY_NAME_MAP.put("LC", "圣卢西亚");
        COUNTRY_NAME_MAP.put("VC", "圣文森特和格林纳丁斯");
        COUNTRY_NAME_MAP.put("TT", "特立尼达和多巴哥");
        COUNTRY_NAME_MAP.put("BZ", "伯利兹");
        COUNTRY_NAME_MAP.put("SV", "萨尔瓦多");
        COUNTRY_NAME_MAP.put("UM", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("VI", "美属维尔京群岛");
        COUNTRY_NAME_MAP.put("BM", "百慕大");
        COUNTRY_NAME_MAP.put("KY", "开曼群岛");
        COUNTRY_NAME_MAP.put("GP", "瓜德罗普");
        COUNTRY_NAME_MAP.put("MQ", "马提尼克");
        COUNTRY_NAME_MAP.put("PM", "圣皮埃尔和密克隆");
        COUNTRY_NAME_MAP.put("TC", "特克斯和凯科斯群岛");
        COUNTRY_NAME_MAP.put("VG", "英属维尔京群岛");
        COUNTRY_NAME_MAP.put("AI", "安圭拉");
        COUNTRY_NAME_MAP.put("AW", "阿鲁巴");
        COUNTRY_NAME_MAP.put("CW", "库拉索");
        COUNTRY_NAME_MAP.put("SX", "圣马丁岛");
        COUNTRY_NAME_MAP.put("BQ", "荷兰加勒比区");
        COUNTRY_NAME_MAP.put("GU", "关岛");
        COUNTRY_NAME_MAP.put("MP", "北马里亚纳群岛");
        COUNTRY_NAME_MAP.put("AS", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("GL", "格陵兰");
        COUNTRY_NAME_MAP.put("MH", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("FM", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("PW", "帕劳");
        COUNTRY_NAME_MAP.put("A1", "匿名代理");
        COUNTRY_NAME_MAP.put("AN", "荷属安的列斯"); // 已解体

        // 南美洲国家
        COUNTRY_NAME_MAP.put("AR", "阿根廷");
        COUNTRY_NAME_MAP.put("BR", "巴西");
        COUNTRY_NAME_MAP.put("CL", "智利");
        COUNTRY_NAME_MAP.put("CO", "哥伦比亚");
        COUNTRY_NAME_MAP.put("EC", "厄瓜多尔");
        COUNTRY_NAME_MAP.put("PE", "秘鲁");
        COUNTRY_NAME_MAP.put("PY", "巴拉圭");
        COUNTRY_NAME_MAP.put("UY", "乌拉圭");
        COUNTRY_NAME_MAP.put("VE", "委内瑞拉");
        COUNTRY_NAME_MAP.put("BO", "玻利维亚");
        COUNTRY_NAME_MAP.put("GF", "法属圭亚那");
        COUNTRY_NAME_MAP.put("SR", "苏里南");
        COUNTRY_NAME_MAP.put("GY", "圭亚那");
        COUNTRY_NAME_MAP.put("FK", "福克兰群岛");

        // 非洲国家
        COUNTRY_NAME_MAP.put("DZ", "阿尔及利亚");
        COUNTRY_NAME_MAP.put("EG", "埃及");
        COUNTRY_NAME_MAP.put("GA", "加蓬");
        COUNTRY_NAME_MAP.put("GH", "加纳");
        COUNTRY_NAME_MAP.put("KE", "肯尼亚");
        COUNTRY_NAME_MAP.put("LS", "莱索托");
        COUNTRY_NAME_MAP.put("MA", "摩洛哥");
        COUNTRY_NAME_MAP.put("NG", "尼日利亚");
        COUNTRY_NAME_MAP.put("RW", "卢旺达");
        COUNTRY_NAME_MAP.put("TN", "突尼斯");
        COUNTRY_NAME_MAP.put("TZ", "坦桑尼亚");
        COUNTRY_NAME_MAP.put("UG", "乌干达");
        COUNTRY_NAME_MAP.put("ZA", "南非");
        COUNTRY_NAME_MAP.put("ZW", "津巴布韦");
        COUNTRY_NAME_MAP.put("BF", "布基纳法索");
        COUNTRY_NAME_MAP.put("BI", "布隆迪");
        COUNTRY_NAME_MAP.put("CM", "喀麦隆");
        COUNTRY_NAME_MAP.put("CD", "刚果民主共和国");
        COUNTRY_NAME_MAP.put("CG", "刚果共和国");
        COUNTRY_NAME_MAP.put("CI", "科特迪瓦");
        COUNTRY_NAME_MAP.put("DJ", "吉布提");
        COUNTRY_NAME_MAP.put("ER", "厄立特里亚");
        COUNTRY_NAME_MAP.put("ET", "埃塞俄比亚");
        COUNTRY_NAME_MAP.put("GM", "冈比亚");
        COUNTRY_NAME_MAP.put("GN", "几内亚");
        COUNTRY_NAME_MAP.put("GW", "几内亚比绍");
        COUNTRY_NAME_MAP.put("LY", "利比亚");
        COUNTRY_NAME_MAP.put("MG", "马达加斯加");
        COUNTRY_NAME_MAP.put("ML", "马里");
        COUNTRY_NAME_MAP.put("MR", "毛里塔尼亚");
        COUNTRY_NAME_MAP.put("MU", "毛里求斯");
        COUNTRY_NAME_MAP.put("MW", "马拉维");
        COUNTRY_NAME_MAP.put("MZ", "莫桑比克");
        COUNTRY_NAME_MAP.put("NA", "纳米比亚");
        COUNTRY_NAME_MAP.put("NE", "尼日尔");
        COUNTRY_NAME_MAP.put("RE", "留尼汪");
        COUNTRY_NAME_MAP.put("SN", "塞内加尔");
        COUNTRY_NAME_MAP.put("SL", "塞拉利昂");
        COUNTRY_NAME_MAP.put("SO", "索马里");
        COUNTRY_NAME_MAP.put("SS", "南苏丹");
        COUNTRY_NAME_MAP.put("ST", "圣多美和普林西比");
        COUNTRY_NAME_MAP.put("SZ", "斯威士兰");
        COUNTRY_NAME_MAP.put("TD", "乍得");
        COUNTRY_NAME_MAP.put("TG", "多哥");
        COUNTRY_NAME_MAP.put("YT", "马约特");
        COUNTRY_NAME_MAP.put("ZM", "赞比亚");
        COUNTRY_NAME_MAP.put("EH", "西撒哈拉");
        COUNTRY_NAME_MAP.put("SH", "圣赫勒拿");
        COUNTRY_NAME_MAP.put("KM", "科摩罗");
        COUNTRY_NAME_MAP.put("CV", "佛得角");
        COUNTRY_NAME_MAP.put("GQ", "赤道几内亚");
        COUNTRY_NAME_MAP.put("LR", "利比里亚");
        COUNTRY_NAME_MAP.put("SC", "塞舌尔");
        COUNTRY_NAME_MAP.put("SD", "苏丹");
        COUNTRY_NAME_MAP.put("IO", "英属印度洋领地");

        // 大洋洲国家
        COUNTRY_NAME_MAP.put("AU", "澳大利亚");
        COUNTRY_NAME_MAP.put("NZ", "新西兰");
        COUNTRY_NAME_MAP.put("PG", "巴布亚新几内亚");
        COUNTRY_NAME_MAP.put("FJ", "斐济");
        COUNTRY_NAME_MAP.put("KI", "基里巴斯");
        COUNTRY_NAME_MAP.put("NC", "新喀里多尼亚");
        COUNTRY_NAME_MAP.put("SB", "所罗门群岛");
        COUNTRY_NAME_MAP.put("TO", "汤加");
        COUNTRY_NAME_MAP.put("TV", "图瓦卢");
        COUNTRY_NAME_MAP.put("VU", "瓦努阿图");
        COUNTRY_NAME_MAP.put("WF", "瓦利斯和富图纳");
        COUNTRY_NAME_MAP.put("AS", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("CK", "库克群岛");
        COUNTRY_NAME_MAP.put("FM", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("GU", "关岛");
        COUNTRY_NAME_MAP.put("MH", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("MP", "北马里亚纳群岛");
        COUNTRY_NAME_MAP.put("NR", "瑙鲁");
        COUNTRY_NAME_MAP.put("NU", "纽埃");
        COUNTRY_NAME_MAP.put("PW", "帕劳");
        COUNTRY_NAME_MAP.put("PN", "皮特凯恩群岛");
        COUNTRY_NAME_MAP.put("TK", "托克劳");
        COUNTRY_NAME_MAP.put("UM", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("CX", "圣诞岛");
        COUNTRY_NAME_MAP.put("CC", "科科斯群岛");
        COUNTRY_NAME_MAP.put("NF", "诺福克岛");
        COUNTRY_NAME_MAP.put("GS", "南乔治亚和南桑威奇群岛");

        // 其他特殊情况
        COUNTRY_NAME_MAP.put("COUNTRY NOT SPECIFIED", "未指定国家");
        COUNTRY_NAME_MAP.put("A1", "匿名代理");
        COUNTRY_NAME_MAP.put("A2", "卫星提供商");
        COUNTRY_NAME_MAP.put("O1", "其他国家");

        // 南极洲
        COUNTRY_NAME_MAP.put("AQ", "南极洲");


        // 亚洲
        COUNTRY_NAME_MAP.put("CHINA", "中国");
        COUNTRY_NAME_MAP.put("JAPAN", "日本");
        COUNTRY_NAME_MAP.put("INDIA", "印度");
        COUNTRY_NAME_MAP.put("SOUTH KOREA", "韩国"); // "KOREA, REPUBLIC OF" 标准译名
        COUNTRY_NAME_MAP.put("NORTH KOREA", "朝鲜"); // "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" 标准译名
        COUNTRY_NAME_MAP.put("TURKEY", "土耳其");
        COUNTRY_NAME_MAP.put("SINGAPORE", "新加坡");
        COUNTRY_NAME_MAP.put("LEBANON", "黎巴嫩");
        COUNTRY_NAME_MAP.put("INDONESIA", "印度尼西亚");
        COUNTRY_NAME_MAP.put("THAILAND", "泰国");
        COUNTRY_NAME_MAP.put("PHILIPPINES", "菲律宾");
        COUNTRY_NAME_MAP.put("SAUDI ARABIA", "沙特阿拉伯");
        COUNTRY_NAME_MAP.put("UNITED ARAB EMIRATES", "阿拉伯联合酋长国");
        COUNTRY_NAME_MAP.put("KUWAIT", "科威特");
        COUNTRY_NAME_MAP.put("QATAR", "卡塔尔");
        COUNTRY_NAME_MAP.put("JORDAN", "约旦");
        COUNTRY_NAME_MAP.put("IRAN (ISLAMIC REPUBLIC OF)", "伊朗");
        COUNTRY_NAME_MAP.put("PAKISTAN", "巴基斯坦");
        COUNTRY_NAME_MAP.put("BANGLADESH", "孟加拉国");
        COUNTRY_NAME_MAP.put("SRI LANKA", "斯里兰卡");
        COUNTRY_NAME_MAP.put("CAMBODIA", "柬埔寨");
        COUNTRY_NAME_MAP.put("LAO PEOPLE'S DEMOCRATIC REPUBLIC", "老挝");
        COUNTRY_NAME_MAP.put("MYANMAR", "缅甸");
        COUNTRY_NAME_MAP.put("VIET NAM", "越南");
        COUNTRY_NAME_MAP.put("MALAYSIA", "马来西亚");
        COUNTRY_NAME_MAP.put("BRUNEI DARUSSALAM", "文莱");
        COUNTRY_NAME_MAP.put("OMAN", "阿曼");
        COUNTRY_NAME_MAP.put("BAHRAIN", "巴林");
        COUNTRY_NAME_MAP.put("AFGHANISTAN", "阿富汗");
        COUNTRY_NAME_MAP.put("YEMEN", "也门");
        COUNTRY_NAME_MAP.put("CYPRUS", "塞浦路斯"); // 地理上属于亚洲，但部分国际组织归类为欧洲
        COUNTRY_NAME_MAP.put("GEORGIA", "格鲁吉亚"); // 跨欧亚两洲，通常归为亚洲
        COUNTRY_NAME_MAP.put("KAZAKHSTAN", "哈萨克斯坦");
        COUNTRY_NAME_MAP.put("KYRGYZSTAN", "吉尔吉斯斯坦");
        COUNTRY_NAME_MAP.put("UZBEKISTAN", "乌兹别克斯坦");
        COUNTRY_NAME_MAP.put("TAIWAN, PROVINCE OF CHINA", "中国台湾地区"); // 中国不可分割的一部分
        COUNTRY_NAME_MAP.put("HONG KONG", "中国香港特别行政区");
        COUNTRY_NAME_MAP.put("MACAU", "中国澳门特别行政区");

        // 欧洲
        COUNTRY_NAME_MAP.put("ITALY", "意大利");
        COUNTRY_NAME_MAP.put("FRANCE", "法国");
        COUNTRY_NAME_MAP.put("GERMANY", "德国");
        COUNTRY_NAME_MAP.put("UNITED KINGDOM", "英国");
        COUNTRY_NAME_MAP.put("SWITZERLAND", "瑞士");
        COUNTRY_NAME_MAP.put("NETHERLANDS", "荷兰");
        COUNTRY_NAME_MAP.put("SPAIN", "西班牙");
        COUNTRY_NAME_MAP.put("IRELAND", "爱尔兰");
        COUNTRY_NAME_MAP.put("RUSSIAN FEDERATION", "俄罗斯");
        COUNTRY_NAME_MAP.put("POLAND", "波兰");
        COUNTRY_NAME_MAP.put("BELGIUM", "比利时");
        COUNTRY_NAME_MAP.put("DENMARK", "丹麦");
        COUNTRY_NAME_MAP.put("GREECE", "希腊");
        COUNTRY_NAME_MAP.put("SWEDEN", "瑞典");
        COUNTRY_NAME_MAP.put("PORTUGAL", "葡萄牙");
        COUNTRY_NAME_MAP.put("HUNGARY", "匈牙利");
        COUNTRY_NAME_MAP.put("CZECH REPUBLIC", "捷克");
        COUNTRY_NAME_MAP.put("LITHUANIA", "立陶宛");
        COUNTRY_NAME_MAP.put("ROMANIA", "罗马尼亚");
        COUNTRY_NAME_MAP.put("BULGARIA", "保加利亚");
        COUNTRY_NAME_MAP.put("ESTONIA", "爱沙尼亚");
        COUNTRY_NAME_MAP.put("LATVIA", "拉脱维亚");
        COUNTRY_NAME_MAP.put("SERBIA", "塞尔维亚");
        COUNTRY_NAME_MAP.put("CROATIA (LOCAL NAME: HRVATSKA)", "克罗地亚");
        COUNTRY_NAME_MAP.put("SLOVENIA", "斯洛文尼亚");
        COUNTRY_NAME_MAP.put("SLOVAKIA (SLOVAK REPUBLIC)", "斯洛伐克");
        COUNTRY_NAME_MAP.put("ALBANIA", "阿尔巴尼亚");
        COUNTRY_NAME_MAP.put("ICELAND", "冰岛");
        COUNTRY_NAME_MAP.put("NORWAY", "挪威");
        COUNTRY_NAME_MAP.put("FINLAND", "芬兰");
        COUNTRY_NAME_MAP.put("AUSTRIA", "奥地利");
        COUNTRY_NAME_MAP.put("BELARUS", "白俄罗斯");
        COUNTRY_NAME_MAP.put("UKRAINE", "乌克兰");
        COUNTRY_NAME_MAP.put("MOLDOVA, REPUBLIC OF", "摩尔多瓦");
        COUNTRY_NAME_MAP.put("MONTENEGRO", "黑山");
        COUNTRY_NAME_MAP.put("MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF", "北马其顿");
        COUNTRY_NAME_MAP.put("BOSNIA AND HERZEGOWINA", "波斯尼亚和黑塞哥维那");
        COUNTRY_NAME_MAP.put("ANDORRA", "安道尔");
        COUNTRY_NAME_MAP.put("MONACO", "摩纳哥");
        COUNTRY_NAME_MAP.put("VATICAN CITY STATE (HOLY SEE)", "梵蒂冈");
        COUNTRY_NAME_MAP.put("LUXEMBOURG", "卢森堡");
        COUNTRY_NAME_MAP.put("SAN MARINO", "圣马力诺");
        COUNTRY_NAME_MAP.put("ISLE OF MAN", "马恩岛");
        COUNTRY_NAME_MAP.put("ALAND ISLANDS", "奥兰群岛");
        COUNTRY_NAME_MAP.put("FAROE ISLANDS", "法罗群岛");
        COUNTRY_NAME_MAP.put("GIBRALTAR", "直布罗陀");

        // 北美洲
        COUNTRY_NAME_MAP.put("UNITED STATES", "美国");
        COUNTRY_NAME_MAP.put("CANADA", "加拿大"); // 修正原数据中的南美洲错误
        COUNTRY_NAME_MAP.put("MEXICO", "墨西哥");
        COUNTRY_NAME_MAP.put("GUATEMALA", "危地马拉");
        COUNTRY_NAME_MAP.put("COSTA RICA", "哥斯达黎加");
        COUNTRY_NAME_MAP.put("TRINIDAD AND TOBAGO", "特立尼达和多巴哥");
        COUNTRY_NAME_MAP.put("PUERTO RICO", "波多黎各");
        COUNTRY_NAME_MAP.put("UNITED STATES MINOR OUTLYING ISLANDS", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("JAMAICA", "牙买加");
        COUNTRY_NAME_MAP.put("SAINT KITTS AND NEVIS", "圣基茨和尼维斯");
        COUNTRY_NAME_MAP.put("EL SALVADOR", "萨尔瓦多");
        COUNTRY_NAME_MAP.put("BARBADOS", "巴巴多斯");
        COUNTRY_NAME_MAP.put("HONDURAS", "洪都拉斯");
        COUNTRY_NAME_MAP.put("HAITI", "海地");
        COUNTRY_NAME_MAP.put("DOMINICAN REPUBLIC", "多米尼加共和国");
        COUNTRY_NAME_MAP.put("NICARAGUA", "尼加拉瓜");
        COUNTRY_NAME_MAP.put("MONTSERRAT", "蒙特塞拉特");
        COUNTRY_NAME_MAP.put("CUBA", "古巴");
        COUNTRY_NAME_MAP.put("GRENADA", "格林纳达");
        COUNTRY_NAME_MAP.put("ARUBA", "阿鲁巴");
        COUNTRY_NAME_MAP.put("VIRGIN ISLANDS (U.S.)", "美属维尔京群岛");
        COUNTRY_NAME_MAP.put("BAHAMAS", "巴哈马");
        COUNTRY_NAME_MAP.put("BERMUDA", "百慕大");
        COUNTRY_NAME_MAP.put("CAYMAN ISLANDS", "开曼群岛");
        COUNTRY_NAME_MAP.put("DOMINICA", "多米尼克");
        COUNTRY_NAME_MAP.put("ANTIGUA AND BARBUDA", "安提瓜和巴布达");
        COUNTRY_NAME_MAP.put("BELIZE", "伯利兹");

        // 南美洲
        COUNTRY_NAME_MAP.put("BRAZIL", "巴西");
        COUNTRY_NAME_MAP.put("COLOMBIA", "哥伦比亚");
        COUNTRY_NAME_MAP.put("ARGENTINA", "阿根廷"); // 修正原数据中的北美洲错误
        COUNTRY_NAME_MAP.put("VENEZUELA", "委内瑞拉");
        COUNTRY_NAME_MAP.put("PERU", "秘鲁");
        COUNTRY_NAME_MAP.put("CHILE", "智利");
        COUNTRY_NAME_MAP.put("URUGUAY", "乌拉圭");
        COUNTRY_NAME_MAP.put("BOLIVIA", "玻利维亚");
        COUNTRY_NAME_MAP.put("SURINAME", "苏里南");
        COUNTRY_NAME_MAP.put("GUYANA", "圭亚那");
        COUNTRY_NAME_MAP.put("FRENCH GUIANA", "法属圭亚那");

        // 非洲
        COUNTRY_NAME_MAP.put("SOUTH AFRICA", "南非"); // 修正原数据中的南美洲错误
        COUNTRY_NAME_MAP.put("ALGERIA", "阿尔及利亚");
        COUNTRY_NAME_MAP.put("EGYPT", "埃及");
        COUNTRY_NAME_MAP.put("TUNISIA", "突尼斯");
        COUNTRY_NAME_MAP.put("MOROCCO", "摩洛哥");
        COUNTRY_NAME_MAP.put("NIGERIA", "尼日利亚");
        COUNTRY_NAME_MAP.put("KENYA", "肯尼亚");
        COUNTRY_NAME_MAP.put("BOTSWANA", "博茨瓦纳");
        COUNTRY_NAME_MAP.put("CONGO", "刚果共和国");
        COUNTRY_NAME_MAP.put("CONGO, THE DEMOCRATIC REPUBLIC OF THE", "刚果民主共和国");
        COUNTRY_NAME_MAP.put("COTE D'IVOIRE", "科特迪瓦");
        COUNTRY_NAME_MAP.put("BURKINA FASO", "布基纳法索");
        COUNTRY_NAME_MAP.put("TOGO", "多哥");
        COUNTRY_NAME_MAP.put("UGANDA", "乌干达");
        COUNTRY_NAME_MAP.put("LIBERIA", "利比里亚");
        COUNTRY_NAME_MAP.put("SENEGAL", "塞内加尔");
        COUNTRY_NAME_MAP.put("GHANA", "加纳");
        COUNTRY_NAME_MAP.put("GABON", "加蓬");
        COUNTRY_NAME_MAP.put("CAMEROON", "喀麦隆");
        COUNTRY_NAME_MAP.put("BENIN", "贝宁");
        COUNTRY_NAME_MAP.put("MAURITIUS", "毛里求斯");
        COUNTRY_NAME_MAP.put("MADAGASCAR", "马达加斯加");
        COUNTRY_NAME_MAP.put("TANZANIA, UNITED REPUBLIC OF", "坦桑尼亚");
        COUNTRY_NAME_MAP.put("RWANDA", "卢旺达");
        COUNTRY_NAME_MAP.put("BURUNDI", "布隆迪");
        COUNTRY_NAME_MAP.put("LESOTHO", "莱索托");
        COUNTRY_NAME_MAP.put("SWAZILAND", "斯威士兰"); // 现称 "ESWATINI"，但保留原映射
        COUNTRY_NAME_MAP.put("NAMIBIA", "纳米比亚");
        COUNTRY_NAME_MAP.put("ZAMBIA", "赞比亚");
        COUNTRY_NAME_MAP.put("ZIMBABWE", "津巴布韦");
        COUNTRY_NAME_MAP.put("SUDAN", "苏丹");
        COUNTRY_NAME_MAP.put("LIBYAN ARAB JAMAHIRIYA", "利比亚");
        COUNTRY_NAME_MAP.put("ERITREA", "厄立特里亚"); // 原数据未包含，补充常见国家
        COUNTRY_NAME_MAP.put("ETHIOPIA", "埃塞俄比亚");
        COUNTRY_NAME_MAP.put("DJIBOUTI", "吉布提"); // 原数据未包含，补充常见国家

        // 大洋洲
        COUNTRY_NAME_MAP.put("AUSTRALIA", "澳大利亚");
        COUNTRY_NAME_MAP.put("NEW ZEALAND", "新西兰");
        COUNTRY_NAME_MAP.put("FIJI", "斐济");
        COUNTRY_NAME_MAP.put("PAPUA NEW GUINEA", "巴布亚新几内亚"); // 修正原数据中的非洲错误
        COUNTRY_NAME_MAP.put("NEW CALEDONIA", "新喀里多尼亚");
        COUNTRY_NAME_MAP.put("MICRONESIA, FEDERATED STATES OF", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("SAMOA", "萨摩亚");
        COUNTRY_NAME_MAP.put("AMERICAN SAMOA", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("TONGA", "汤加");
        COUNTRY_NAME_MAP.put("COOK ISLANDS", "库克群岛");
        COUNTRY_NAME_MAP.put("NIUE", "纽埃");
        COUNTRY_NAME_MAP.put("VANUATU", "瓦努阿图");
        COUNTRY_NAME_MAP.put("PALAU", "帕劳");
        COUNTRY_NAME_MAP.put("MARSHALL ISLANDS", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("NORFOLK ISLAND", "诺福克岛");
        COUNTRY_NAME_MAP.put("TOKELAU", "托克劳");
        COUNTRY_NAME_MAP.put("WALLIS AND FUTUNA ISLANDS", "瓦利斯和富图纳");
        COUNTRY_NAME_MAP.put("KIRIBATI", "基里巴斯");

        // 特殊地区/组织
        COUNTRY_NAME_MAP.put("EUROPEAN UNION", "欧洲联盟");
        COUNTRY_NAME_MAP.put("PALESTINIAN TERRITORY, OCCUPIED", "巴勒斯坦地区");
        COUNTRY_NAME_MAP.put("SOUTH GEORGIA AND THE SOUTH SANDWICH ISLANDS", "南乔治亚和南桑威奇群岛");
        COUNTRY_NAME_MAP.put("ANTARCTICA", "南极洲"); // 原数据中的 "SVALBARD AND JAN MAYEN ISLANDS" 属欧洲，此处修正


    }




    public static void main(String[] args) {
        // 假设 mongoUtil 已经初始化
        FearsMongoUtil mongoUtil = new FearsMongoUtil();

        String connectionString = requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3");
        try (MongoClient client = MongoClients.create(connectionString)) {
            // 获取数据库
            MongoDatabase database = client.getDatabase("original_individual_case_3");

            String folderPath = "C:\\Users\\Administrator\\Desktop\\新建文件夹 (2)"; // 替换为你的文件夹路径
            MongoCollection<Document> collection = database.getCollection("merged_DEMOOnly");
            // 获取文件夹中所有文本文件
            File folder = new File(folderPath);
            File[] files = folder.listFiles((dir, name) -> name.toLowerCase().endsWith(".txt"));
            if (files == null || files.length == 0) {
                System.out.println("未找到文本文件");
                return;
            }
            System.out.println("找到 " + files.length + " 个文本文件");
            // 初始化计数器
            int totalFiles = files.length;
            int processedFiles = 0;
            long totalDeleted = 0;
            int batchSize = 1000;
            // 处理每个文件
            for (File file : files) {
                try {
                    // 读取文件中的 ID
                    List<String> idsToDelete = readIdsFromFile(file);
                    if (idsToDelete.isEmpty()) {
                        System.out.println("文件 " + file.getName() + " 为空，跳过");
                        continue;
                    }
                    // 分批处理
                    for (int i = 0; i < idsToDelete.size(); i += batchSize) {
                        List<String> batch = idsToDelete.subList(i, Math.min(i + batchSize, idsToDelete.size()));
                        // 构建查询条件
                        Document query = new Document("_id", new Document("$in", batch));
                        // 执行删除
                        DeleteResult result = collection.deleteMany(query);
                        totalDeleted += result.getDeletedCount();
                    }
                    processedFiles++;
                    System.out.println("已处理文件 " + processedFiles + "/" + totalFiles +
                            "：" + file.getName() + "，删除 " + idsToDelete.size() + " 条记录");
                } catch (Exception e) {
                    System.out.println("处理文件 " + file.getName() + " 时出错：" + e.getMessage());
                    e.printStackTrace();
                }
            }
            System.out.println("操作完成！共处理 " + processedFiles + " 个文件，删除 " + totalDeleted + " 条记录");
        } catch (Exception e) {
            System.err.println("操作数据库时出错：" + e.getMessage());
            e.printStackTrace();
        }
    }


    // 从文件读取 ID 列表
    private static List<String> readIdsFromFile(File file) throws IOException {
        List<String> ids = new ArrayList<>();
        try (BufferedReader br = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = br.readLine()) != null) {
                line = line.trim();
                if (!line.isEmpty()) {
                    ids.add(line);
                }
            }
        }
        return ids;
    }


}


