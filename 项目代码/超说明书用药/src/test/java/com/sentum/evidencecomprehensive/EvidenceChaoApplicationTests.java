package com.sentum.evidencecomprehensive;

import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.poi.excel.ExcelReader;
import cn.hutool.poi.excel.ExcelUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.InsertManyOptions;
import com.sentum.evidencecomprehensive.infrastructure.kafka.KafkaSender;
import com.sentum.evidencecomprehensive.pojo.bo.es.AdverseForCaseIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.AdverseIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.EvidenceClinicalTrials;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.EvidenceAct;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.EvidenceCMesh;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.EvidenceMesh;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Icd10;
import com.sentum.evidencecomprehensive.utils.DataMongoUtil;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.commons.collections.CollectionUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.TermQueryBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.script.ScriptType;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.junit.jupiter.api.Test;
import org.junit.platform.commons.util.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.IndexOperations;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Query;
import org.bson.Document;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@SpringBootTest
class EvidenceChaoApplicationTests {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        org.junit.jupiter.api.Assumptions.assumeTrue(
                value != null && !value.trim().isEmpty(),
                name + " is required for this external MongoDB integration test"
        );
        return value.trim();
    }
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private KafkaSender kafkaSender;

    @Test
    public void test16() {
        String connectionString = requiredMongoUri("EVIMED_MONGODB_URI_READUSER1_LXLZRSERVER1_192_168_20_134_27017");
        // 源数据库名称
        String sourceDatabaseName = "original_individual_case_3";
        // 要查询的集合名称
        // String collectionName = "filtered_new_collection_不良反应全";
        String collectionName = "newCollectionCopy";
        // 假设在这个字段中查找是否包含 word，可根据实际情况修改
        String searchField = "pt_list";
        String targetCollectionName = "new_collection_信号";

        // 定义要查找的 word 列表
        List<String> words = Arrays.asList(
                "Hypertension",
        "Blood Pressure, High",
                "Blood Pressures, High",
                "High Blood Pressure",
                "High Blood Pressures",
        //         "QT prolongation",
        //         "Electrocardiogram QT Prolonged",
        //         "Long QT Syndrome"
        //         "Atrial Fibrillation",
        //         "Atrial Fibrillations",
        //         "Fibrillation, Atrial",
        //         "Fibrillations, Atrial",
        //         "Auricular Fibrillation",
        //         "Auricular Fibrillations",
        //         "Fibrillation, Auricular",
        //         "Fibrillations, Auricular",
        //         "Persistent Atrial Fibrillation",
        //         "Atrial Fibrillation, Persistent",
        //         "Atrial Fibrillations, Persistent",
        //         "Fibrillation, Persistent Atrial",
        //         "Fibrillations, Persistent Atrial",
        //         "Persistent Atrial Fibrillations",
        //         "Familial Atrial Fibrillation",
        //         "Atrial Fibrillation, Familial",
        //         "Atrial Fibrillations, Familial",
        //         "Familial Atrial Fibrillations",
        //         "Fibrillation, Familial Atrial",
        //         "Fibrillations, Familial Atrial",
        //         "Paroxysmal Atrial Fibrillation",
        //         "Atrial Fibrillation, Paroxysmal",
        //         "Atrial Fibrillations, Paroxysmal",
        //         "Fibrillation, Paroxysmal Atrial",
        //         "Fibrillations, Paroxysmal Atrial",
        //         "Paroxysmal Atrial Fibrillations"
                "Heart Arrest",
                "cardiac arrest",
                "Arrest, Heart",
                "Asystole",
                "Asystoles",
                "Cardiac Arrest",
                "Arrest, Cardiac",
                "Cardiopulmonary Arrest",
                "Arrest, Cardiopulmonary",
                "myocardial laypertrophy",
                "Cardiac hypertrophy",
                "Enlarged Heart",
                "Heart, Enlarged",
                "Heart Enlargement",
                "Enlargement, Heart",
                "Cardiac Hypertrophy",
                "Cardiac Hypertrophies",
                "Hypertrophies, Cardiac",
                "Hypertrophy, Cardiac",
                "Heart Hypertrophy",
                "Heart Hypertrophies",
                "Hypertrophies, Heart",
                "Hypertrophy, Heart",
        //         "Congestive heart failure"
        //         "Myocardial Infarction",
        //         "Infarction, Myocardial",
        //         "Infarctions, Myocardial",
        //         "Myocardial Infarctions",
        //         "Heart Attack",
        //         "Heart Attacks",
        //         "Myocardial Infarct",
        //         "Infarct, Myocardial",
        //         "Infarcts, Myocardial",
        //         "Myocardial Infarcts",
        //         "Cardiovascular Stroke",
        //         "Cardiovascular Strokes",
        //         "Stroke, Cardiovascular",
        //         "Strokes, Cardiovascular"
        //         "Coronaryspasm",
        //         "coronary artery vasospasm",
        //         "Coronary Vasospasm",
        //         "Coronary Vasospasms",
        //         "Vasospasm, Coronary",
        //         "Coronary Artery Vasospasm",
        //         "Artery Vasospasm, Coronary",
        //         "Coronary Artery Vasospasms",
        //         "Vasospasm, Coronary Artery",
        //         "Coronary Artery Spasm",
        //         "Artery Spasm, Coronary",
        //         "Coronary Artery Spasms",
        //         "Spasm, Coronary Artery"
        //         "Ischaemic Coronary Disease"
        //         "Tachycardia",
        //         "Tachycardias",
        //         "Tachyarrhythmia",
        //         "Tachyarrhythmias"
        //         "ventricular arrhythmias"
                "Heart Failure",
                "Cardiac Failure",
                "Heart Decompensation",
                "Decompensation, Heart",
                "Congestive Heart Failure",
                "Heart Failure, Congestive",
                "Heart Failure, Right-Sided",
                "Heart Failure, Right Sided",
                "Right-Sided Heart Failure",
                "Right Sided Heart Failure",
                "Heart Failure, Left-Sided",
                "Heart Failure, Left Sided",
                "Left-Sided Heart Failure",
                "Left Sided Heart Failure",
                "Myocardial Failure",
                "Cardiomyopathies",
                "Cardiomyopathy",
                "Myocardial Disease",
                "Disease, Myocardial",
                "Diseases, Myocardial",
                "Myocardial Diseases",
                "Myocardiopathies",
                "Myocardiopathy",
                "Cardiomyopathies, Primary",
                "Cardiomyopathy, Primary",
                "Primary Cardiomyopathies",
                "Primary Cardiomyopathy",
                "Primary Myocardial Disease",
                "Disease, Primary Myocardial",
                "Diseases, Primary Myocardial",
                "Myocardial Disease, Primary",
                "Myocardial Diseases, Primary",
                "Primary Myocardial Diseases",
                "Cardiomyopathies, Secondary",
                "Cardiomyopathy, Secondary",
                "Secondary Cardiomyopathies",
                "Secondary Cardiomyopathy",
                "Myocardial Diseases, Secondary",
                "Disease, Secondary Myocardial",
                "Diseases, Secondary Myocardial",
                "Myocardial Disease, Secondary",
                "Secondary Myocardial Disease",
                "Secondary Myocardial Diseases",
                "ventricular hypertrophy",
                "Hypertrophy, Right Ventricular",
                "Right Ventricular Hypertrophy",
                "Hypertrophies, Right Ventricular",
                "Right Ventricular Hypertrophies",
                "Ventricular Hypertrophies, Right",
                "Ventricular Hypertrophy, Right",
                "Hypertrophy, Left Ventricular",
                "Left Ventricular Hypertrophy",
                "Hypertrophies, Left Ventricular",
                "Left Ventricular Hypertrophies",
                "Ventricular Hypertrophies, Left",
                "Ventricular Hypertrophy, Left"
        //         "supraventricular arrhythmia"
        //         "Palpitation"
        //         "Heart Arrest"
);

        try (MongoClient mongoClient = MongoClients.create(connectionString)) {
            // 获取源数据库
            MongoDatabase sourceDatabase = mongoClient.getDatabase(sourceDatabaseName);
            // 获取要查询的集合
            MongoCollection<Document> collection = sourceDatabase.getCollection(collectionName);

            // 获取新集合，如果不存在会自动创建
            MongoCollection<Document> targetCollection = sourceDatabase.getCollection(targetCollectionName);


            // 构建查询条件，不区分大小写查找包含任一 word 的文档
            List<org.bson.conversions.Bson> orFilters = words.stream()
                    .map(word -> Filters.regex(searchField, "^" + word + "$", "i"))
                    .collect(Collectors.toList());
            org.bson.conversions.Bson query = Filters.or(orFilters);

            // 查询符合条件的文档
            List<Document> filteredDocuments = collection.find(query).into(new ArrayList<>());




            if (!filteredDocuments.isEmpty()) {
                // 将过滤出的文档插入到新集合中
                targetCollection.insertMany(filteredDocuments, new InsertManyOptions().ordered(false));
            }

            System.out.println("数据过滤并插入新集合完成。");

            System.out.println("数据过滤完成。");
        } catch (Exception e) {
            e.printStackTrace();
        }

    }

    @Test
    public void test15() {
        // MongoDB 连接字符串
        String connectionString = requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3");
        // 每批次查询的 `combine_id` 数量
        int batchSize = 100;
        // 源数据库名称
        String sourceDatabaseName = "original_individual_case_3";
        // 从该集合获取 `combine_id`
        String sourceCollectionForIdsName = "new_collection_信号";
        // 从中查询对应数据的集合
        String sourceCollectionForDataName = "mergedCollectionx";
        // 目标集合名称，用于插入查询到的数据
        String targetCollectionName = "new_collection_信号全";

        try (MongoClient mongoClient = MongoClients.create(connectionString)) {
            // 获取源数据库
            MongoDatabase sourceDatabase = mongoClient.getDatabase(sourceDatabaseName);
            // 获取用于获取 `combine_id` 的集合
            MongoCollection<Document> sourceCollectionForIds = sourceDatabase.getCollection(sourceCollectionForIdsName);
            // 获取用于查询数据的集合
            MongoCollection<Document> sourceCollectionForData = sourceDatabase.getCollection(sourceCollectionForDataName);
            // 获取目标集合
            MongoCollection<Document> targetCollection = sourceDatabase.getCollection(targetCollectionName);

            // 从 sourceCollectionForIds 集合获取所有的 `combine_id`
            List<String> allCombineIds = sourceCollectionForIds.find()
                    .map(doc -> doc.getString("combine_id"))
                    .into(new ArrayList<>());

            // 分批次查询并插入数据
            for (int i = 0; i < allCombineIds.size(); i += batchSize) {
                int endIndex = Math.min(i + batchSize, allCombineIds.size());
                List<String> batchCombineIds = allCombineIds.subList(i, endIndex);

                // 构建查询条件
                org.bson.conversions.Bson query = Filters.in("combine_id", batchCombineIds);

                // 查询符合条件的文档
                List<Document> documents = sourceCollectionForData.find(query).into(new ArrayList<>());

                if (!documents.isEmpty()) {
                    // 将查询到的文档插入到目标集合中
                    targetCollection.insertMany(documents, new InsertManyOptions().ordered(false));
                }
            }

            System.out.println("数据查询和插入完成。");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }



    @Test
    void testReport() {
        JSONObject dataJson = new JSONObject();
        dataJson.put("id", "f1cfa8ff-f17e-4cf0-9734-65c9564632fc");
        dataJson.put("userId", "1793142644897669120");
        dataJson.put("token", "a3b0029006eb4887be0d71458001d19d");
        dataJson.put("type", "超说明书用药循证报告");
        dataJson.put("name", "贝利尤单抗治疗系统性红斑狼疮超说明书用药循证报告.doc");
        dataJson.put("url", "http://192.168.20.252:2023/api-evimed/evidence-api/super-manual-api/download?id=259e92e8-a719-4a8f-a8d1-f3f669145e82");
        dataJson.put("startTime", "2024-07-24 16:27:22");
        dataJson.put("endTime", "2024-07-24 16:30:24");
        kafkaSender.sendReportInfo(dataJson);
    }
  
    /**
     * 将excel中icd10饿数据写入mongo中
     */
    @Test
    void icd10() {
        List<Icd10> list = new ArrayList<>();
        ExcelReader reader = ExcelUtil.getReader("C:\\Users\\Admin\\Desktop\\循证综合评价\\ICD 10中英对照版-20231017.xlsx");
        List<Map<String, Object>> all = reader.readAll();
        for (int i = 0; i < all.size(); i++) {
            Icd10 icd10 = new Icd10();
            icd10.setId(UUID.randomUUID().toString());
            Map<String, Object> map = all.get(i);
            String diagnosisChinese = map.get("诊断名称-中文").toString();
            String diagnosisEnglish = map.get("诊断名称-英文").toString();
            if (StringUtils.isNotBlank(diagnosisChinese)){
                diagnosisChinese = diagnosisChinese.replaceAll("\n", "");
                icd10.setDiagnosisChinese(diagnosisChinese.toLowerCase());
            }
            if (StringUtils.isNotBlank(diagnosisEnglish)){
                diagnosisEnglish = diagnosisEnglish.replaceAll("\n", "");
                icd10.setDiagnosisEnglish(diagnosisEnglish.toLowerCase());
            }
            icd10.setSort(i+1);
            list.add(icd10);
            if (i/1000==0){
                log.info("----------------第[{}]次写入1000条----------------------", i+1);
            }
        }
        Collection<Icd10> insert = mongoTemplate.insert(list, Icd10.class);
        Collection<Icd10> insertRelease = ReleaseMongoUtil.mongo.insert(list, Icd10.class);
        log.info("----------------[{}]条写入完成----------------------", insert.size());
        log.info("----------------[{}]条写入完成-正式----------------------", insertRelease.size());
    }

    /**
     * 将原始数据库中的mesh和cMesh更新到测试与正式环境
     */
    @Test
    void mesh(){
        int pageSize = 1000;
        long countZh = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "cmesh_quchong2");
        log.info("-----开始更新中文cMesh数据共[{}]-----", countZh);
        int numZh = (int) (countZh%pageSize==0?countZh/pageSize:countZh/pageSize+1);
        for (int i = 0; i < numZh; i++) {
            List<EvidenceCMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "cmesh_quchong2");
            for (JSONObject jsonObject : objectList) {
                EvidenceCMesh cMesh = new EvidenceCMesh();
                //id
                cMesh.setId(UUID.randomUUID().toString());
                //主题词
                String title = jsonObject.getString("title");
                if (StringUtils.isBlank(title)){
                    title = "";
                }
                cMesh.setTitle(title);
                //中文
                String nameZh = jsonObject.getString("namezh");
                if (StringUtils.isBlank(nameZh)){
                    nameZh = "";
                }
                cMesh.setNameZh(nameZh);
                //英文
                String nameEn = jsonObject.getString("nameen");
                if (StringUtils.isBlank(nameEn)){
                    nameEn = "";
                }
                cMesh.setNameEn(nameEn);
                //入口词
                String kuanmc = jsonObject.getString("kuanmc");
                Set<String> setZh = new HashSet<>();
                if (StringUtils.isNotBlank(nameZh)){
                    setZh.add(nameZh.toLowerCase().trim());
                }
                if (StringUtils.isNotBlank(kuanmc)){
                    String[] split = kuanmc.split(";");
                    for (String txt : split) {
                        if (StringUtils.isNotBlank(txt)){
                            txt = StrUtil.trim(txt);
                            setZh.add(txt.toLowerCase().trim());
                        }
                    }
                }
                cMesh.setEntryTerms(new ArrayList<>(setZh));
                //树形结构编码
                String treeNumber = jsonObject.getString("treenumber");
                if (StringUtils.isBlank(treeNumber)){
                    treeNumber = "";
                }
                cMesh.setTreeNumber(treeNumber);
                list.add(cMesh);
            }
            mongoTemplate.insert(list, EvidenceCMesh.class);
            ReleaseMongoUtil.mongo.insert(list, EvidenceCMesh.class);
            log.info("---------------中文cMesh第[{}]次写入1000条------------------", i+1);
        }
        log.info("-----中文cMesh数据写入完成-----");
        long countEn = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "mesh_aspiril_jiexi");
        log.info("-----开始更新英文mesh数据共[{}]-----", countEn);
        int numEn = (int) (countEn%pageSize==0?countEn/pageSize:countEn/pageSize+1);
        for (int i = 0; i < numEn; i++) {
            List<EvidenceMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "mesh_aspiril_jiexi");
            for (JSONObject jsonObject : objectList) {
                EvidenceMesh mesh = new EvidenceMesh();
                //id
                mesh.setId(UUID.randomUUID().toString());
                //主题词
                String title = jsonObject.getString("title");
                if (StringUtils.isBlank(title)){
                    title = "";
                }
                mesh.setTitle(title);
                //入口词
                String kuanmc = jsonObject.getString("Entry_Terms");
                List<String> entryTerms = new ArrayList<>();
                if (StringUtils.isNotBlank(title)){
                    entryTerms.add(title.toLowerCase());
                }
                if (StringUtils.isNotBlank(kuanmc)){
                    String[] split = kuanmc.split("卐");
                    for (String txt : split) {
                        if (StringUtils.isNotBlank(txt)){
                            txt = StrUtil.trim(txt);
                            entryTerms.add(txt.toLowerCase().trim());
                        }
                    }
                }
                mesh.setEntryTerms(entryTerms);
                //树形结构编码
                String treeNumber = jsonObject.getString("Tree_Number");
                if (StringUtils.isBlank(treeNumber)){
                    treeNumber = "";
                }
                mesh.setTreeNumber(treeNumber);
                list.add(mesh);
            }
            mongoTemplate.insert(list, EvidenceMesh.class);
            ReleaseMongoUtil.mongo.insert(list, EvidenceMesh.class);
            log.info("---------------英文mesh第[{}]次写入1000条------------------", i+1);
        }
        log.info("-----英文mesh数据写入完成-----");
    }

    /**
     * 将原始库中中英文干预措施更新到测试与正式环境
     */
    @Test
    void clinicalTrials(){
        int pageSize = 1000;
        long countZh = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "instructions_pico_chictr");
        log.info("-----开始更新中文临床试验数据共[{}]-----", countZh);
        int numZh = (int) (countZh%pageSize==0?countZh/pageSize:countZh/pageSize+1);
        for (int i = 0; i < numZh; i++) {
            List<EvidenceClinicalTrials> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "instructions_pico_chictr");
            for (JSONObject jsonObject : objectList) {
                EvidenceClinicalTrials clinicalTrials = new EvidenceClinicalTrials();
                clinicalTrials.setId(UUID.randomUUID().toString());
                List<String> intervention = new ArrayList<>();
                List<String> outcome = new ArrayList<>();
                //干预措施
                JSONArray interventionArr = jsonObject.getJSONArray("intervention");
                for (int i1 = 0; i1 < interventionArr.size(); i1++) {
                    JSONObject object = interventionArr.getJSONObject(i1);
                    String innerIntervention = object.getString("intervention");
                    String innerInterventionEn = object.getString("intervention_en");
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(innerIntervention)){
                        builder.append(innerIntervention);
                    }
                    if (StringUtils.isNotBlank(innerInterventionEn)){
                        if (builder.length() == 0){
                            builder.append(innerInterventionEn);
                        }else {
                            builder.append("卐").append(innerInterventionEn);
                        }
                    }
                    if (builder.length() != 0){
                        intervention.add(builder.toString());
                    }
                }
                //结局指标
                JSONArray outcomeArr = jsonObject.getJSONArray("outcomes");
                for (int i1 = 0; i1 < outcomeArr.size(); i1++) {
                    JSONObject object = outcomeArr.getJSONObject(i1);
                    String name = object.getString("name");
                    String nameEn = object.getString("name_en");
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(name)){
                        builder.append(name);
                    }
                    if (StringUtils.isNotBlank(nameEn)){
                        if (builder.length() == 0){
                            builder.append(nameEn);
                        }else {
                            builder.append("卐").append(nameEn);
                        }
                    }
                    if (builder.length() != 0){
                        outcome.add(builder.toString());
                    }
                }
                clinicalTrials.setIntervention(intervention);
                clinicalTrials.setOutcome(outcome);
                clinicalTrials.setType(1);
                list.add(clinicalTrials);
            }
            elasticsearchRestTemplate.save(list);
            log.info("---------------中文临床试验第[{}]次写入1000条------------------", i+1);
        }
        log.info("中文临床试验写入完成");
        long countEn = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "instructions_pico_clinicatrials");
        log.info("-----开始更新英文临床试验数据共[{}]-----", countEn);
        int numEn = (int) (countEn%pageSize==0?countEn/pageSize:countEn/pageSize+1);
        for (int i = 0; i < numEn; i++) {
            List<EvidenceClinicalTrials> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "instructions_pico_clinicatrials");
            for (JSONObject jsonObject : objectList) {
                EvidenceClinicalTrials clinicalTrials = new EvidenceClinicalTrials();
                clinicalTrials.setId(UUID.randomUUID().toString());
                List<String> intervention = new ArrayList<>();
                List<String> outcome = new ArrayList<>();
                //干预措施
                JSONArray interventionArr = jsonObject.getJSONArray("intervention");
                for (int i1 = 0; i1 < interventionArr.size(); i1++) {
                    JSONObject object = interventionArr.getJSONObject(i1);
                    String interventionName = object.getString("intervention_name");
                    if (StringUtils.isNotBlank(interventionName)){
                        intervention.add(interventionName);
                    }
                }
                //首要结局指标
                JSONArray primaryOutcome = jsonObject.getJSONArray("primary_outcome");
                if (primaryOutcome != null) {
                    for (int i1 = 0; i1 < primaryOutcome.size(); i1++) {
                        JSONObject object = primaryOutcome.getJSONObject(i1);
                        String measure = object.getString("measure");
                        if (StringUtils.isNotBlank(measure)) {
                            outcome.add(measure);
                        }
                    }
                }
                //次要结局指标
                JSONArray secondaryOutcome = jsonObject.getJSONArray("secondary_outcome");
                if (secondaryOutcome != null) {
                    for (int i1 = 0; i1 < secondaryOutcome.size(); i1++) {
                        JSONObject object = secondaryOutcome.getJSONObject(i1);
                        String measure = object.getString("measure");
                        if (StringUtils.isNotBlank(measure)) {
                            outcome.add(measure);
                        }
                    }
                }
                clinicalTrials.setIntervention(intervention);
                clinicalTrials.setOutcome(outcome);
                clinicalTrials.setType(2);
                list.add(clinicalTrials);
            }
            elasticsearchRestTemplate.save(list);
            log.info("---------------英文临床试验第[{}]次写入1000条------------------", i+1);
        }
        log.info("英文临床试验写入完成");
    }

    /**
     * ACT数据同步mongo
     */
    @Test
    void act(){
        long startTime = System.currentTimeMillis();
        ExcelReader reader = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\循证综合评价\\药品表（总表）-20231007更新.xlsx"), 0);
        List<Map<String, Object>> readAll = reader.readAll();
        log.info("共查询出药品数量为[{}]", readAll.size());
        //用于存储当前词与等级关系
        Map<String, String> codeMap1 = new HashMap<>();
        Map<String, String> codeMap2 = new HashMap<>();
        Map<String, String> codeMap3 = new HashMap<>();
        Map<String, String> codeMap4 = new HashMap<>();
        Map<String, String> codeMap5 = new HashMap<>();
        //生成随机三位数
        Random random = new Random();
        List<EvidenceAct> list = new ArrayList<>();
        //记录数据处理进程
        int num = 0;
        for (Map<String, Object> map : readAll) {
            String firstCode;
            String firstGradeEn = map.get("一级英文") == null ? "" : map.get("一级英文").toString().toLowerCase();
            String firstGradeEnSynonym = map.get("一级英文同义词") == null ? "" : map.get("一级英文同义词").toString().toLowerCase();
            String firstGradeZh = map.get("一级中文") == null ? "" : map.get("一级中文").toString().toLowerCase();
            String firstGradeZhSynonym = map.get("一级中文同义词") == null ? "" : map.get("一级中文同义词").toString().toLowerCase();
            String secondCode;
            String secondGradeEn = map.get("二级英文") == null ? "" : map.get("二级英文").toString().toLowerCase();
            String secondGradeEnSynonym = map.get("二级英文同义词") == null ? "" : map.get("二级英文同义词").toString().toLowerCase();
            String secondGradeZh = map.get("二级中文") == null ? "" : map.get("二级中文").toString().toLowerCase();
            String secondGradeZhSynonym = map.get("二级中文同义词") == null ? "" : map.get("二级中文同义词").toString().toLowerCase();
            String thirdCode;
            String thirdGradeEn = map.get("三级英文") == null ? "" : map.get("三级英文").toString().toLowerCase();
            String thirdGradeEnSynonym = map.get("三级英文同义词") == null ? "" : map.get("三级英文同义词").toString().toLowerCase();
            String thirdGradeZh = map.get("三级中文") == null ? "" : map.get("三级中文").toString().toLowerCase();
            String thirdGradeZhSynonym = map.get("三级中文同义词") == null ? "" : map.get("三级中文同义词").toString().toLowerCase();
            String fourthCode;
            String fourthGradeEn = map.get("四级英文") == null ? "" : map.get("四级英文").toString().toLowerCase();
            String fourthGradeEnSynonym = map.get("四级英文同义词") == null ? "" : map.get("四级英文同义词").toString().toLowerCase();
            String fourthGradeZh = map.get("四级中文") == null ? "" : map.get("四级中文").toString().toLowerCase();
            String fourthGradeZhSynonym = map.get("四级中文同义词") == null ? "" : map.get("四级中文同义词").toString().toLowerCase();
            String fifthCode;
            String fifthGradeZh = map.get("五级中文") == null ? "" : map.get("五级中文").toString().toLowerCase();
            String fifthGradeZhSynonym = map.get("五级中文同义词") == null ? "" : map.get("五级中文同义词").toString().toLowerCase();
            String fifthGradeEn = map.get("五级英文") == null ? "" : map.get("五级英文").toString().toLowerCase();
            String fifthGradeEnSynonym = map.get("五级英文同义词") == null ? "" : map.get("五级英文同义词").toString().toLowerCase();
            //开始进行编码编写
            //一级
            if (StringUtils.isNotBlank(firstGradeEn) || StringUtils.isNotBlank(firstGradeZh)){
                //一级同义词
                List<String> synonym = new ArrayList<>();
                if (StringUtils.isNotBlank(firstGradeEnSynonym)){
                    String[] split = firstGradeEnSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                if (StringUtils.isNotBlank(firstGradeZhSynonym)){
                    String[] split = firstGradeZhSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                //存在一级
                String key = firstGradeEn+firstGradeZh;
                if (codeMap1.containsKey(key)){
                    firstCode = codeMap1.get(key);
                }else {
                    firstCode = "" + (random.nextInt(900) + 100);
                    codeMap1.put(key, firstCode);
                }
                EvidenceAct evidenceAct = new EvidenceAct(UUID.randomUUID().toString(), firstGradeZh, firstGradeEn, synonym, firstCode, 0);
                list.add(evidenceAct);
            }else {
                firstCode = "" + (random.nextInt(900) + 100);
            }
            //二级
            if (StringUtils.isNotBlank(secondGradeEn) || StringUtils.isNotBlank(secondGradeZh)){
                //二级同义词
                List<String> synonym = new ArrayList<>();
                if (StringUtils.isNotBlank(secondGradeEnSynonym)){
                    String[] split = secondGradeEnSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                if (StringUtils.isNotBlank(secondGradeZhSynonym)){
                    String[] split = secondGradeZhSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                //存在二级
                String key = secondGradeEn+secondGradeZh;
                if (codeMap2.containsKey(key)){
                    String txt = codeMap2.get(key);
                    if (txt.contains(firstCode)) {
                        secondCode = txt;
                    }else {
                        secondCode = firstCode + "." + (random.nextInt(900) + 100);
                        codeMap2.put(key, secondCode);
                    }
                }else {
                    secondCode = firstCode + "." + (random.nextInt(900) + 100);
                    codeMap2.put(key, secondCode);
                }
                EvidenceAct evidenceAct = new EvidenceAct(UUID.randomUUID().toString(), secondGradeZh, secondGradeEn, synonym, secondCode, 1);
                list.add(evidenceAct);
            }else {
                secondCode = firstCode + "." + (random.nextInt(900) + 100);
            }
            //三级
            if (StringUtils.isNotBlank(thirdGradeEn) || StringUtils.isNotBlank(thirdGradeZh)){
                //三级同义词
                List<String> synonym = new ArrayList<>();
                if (StringUtils.isNotBlank(thirdGradeEnSynonym)){
                    String[] split = thirdGradeEnSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                if (StringUtils.isNotBlank(thirdGradeZhSynonym)){
                    String[] split = thirdGradeZhSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                //存在三级
                String key = thirdGradeEn+thirdGradeZh;
                if (codeMap3.containsKey(key)){
                    String txt = codeMap3.get(key);
                    if (txt.contains(secondCode)) {
                        thirdCode = txt;
                    }else {
                        thirdCode = secondCode + "." + (random.nextInt(900) + 100);
                        codeMap3.put(key, thirdCode);
                    }
                }else {
                    thirdCode = secondCode + "." + (random.nextInt(900) + 100);
                    codeMap3.put(key, thirdCode);
                }
                EvidenceAct evidenceAct = new EvidenceAct(UUID.randomUUID().toString(), thirdGradeZh, thirdGradeEn, synonym, thirdCode, 2);
                list.add(evidenceAct);
            }else {
                thirdCode = secondCode + "." + (random.nextInt(900) + 100);
            }
            //四级
            if (StringUtils.isNotBlank(fourthGradeEn) || StringUtils.isNotBlank(fourthGradeZh)){
                //四级同义词
                List<String> synonym = new ArrayList<>();
                if (StringUtils.isNotBlank(fourthGradeEnSynonym)){
                    String[] split = fourthGradeEnSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                if (StringUtils.isNotBlank(fourthGradeZhSynonym)){
                    String[] split = fourthGradeZhSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                //存在四级
                String key = fourthGradeEn+fourthGradeZh;
                if (codeMap4.containsKey(key)){
                    String txt = codeMap4.get(key);
                    if (txt.contains(thirdCode)) {
                        fourthCode = txt;
                    }else {
                        fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
                        codeMap4.put(key, fourthCode);
                    }
                }else {
                    fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
                    codeMap4.put(key, fourthCode);
                }
                EvidenceAct evidenceAct = new EvidenceAct(UUID.randomUUID().toString(), fourthGradeZh, fourthGradeEn, synonym, fourthCode, 3);
                list.add(evidenceAct);
            }else {
                fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
            }
            //五级
            if (StringUtils.isNotBlank(fifthGradeZh) || StringUtils.isNotBlank(fifthGradeEn)){
                //五级同义词
                List<String> synonym = new ArrayList<>();
                if (StringUtils.isNotBlank(fifthGradeEnSynonym)){
                    String[] split = fifthGradeEnSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                if (StringUtils.isNotBlank(fifthGradeZhSynonym)){
                    String[] split = fifthGradeZhSynonym.split("卍");
                    synonym.addAll(Arrays.asList(split));
                }
                //存在五级
                String key = fifthGradeEn + fifthGradeZh;
                if (codeMap5.containsKey(key)){
                    String txt = codeMap5.get(key);
                    if (!txt.contains(fourthCode)){
                        fifthCode = fourthCode + "." + (random.nextInt(900) + 100);
                        codeMap5.put(key, fifthCode);
                    }else {
                        fifthCode = txt;
                    }
                }else {
                    fifthCode = fourthCode + "." + (random.nextInt(900) + 100);
                    codeMap5.put(key, fifthCode);
                }
                EvidenceAct evidenceAct = new EvidenceAct(UUID.randomUUID().toString(), fifthGradeZh, fifthGradeEn, synonym, fifthCode, 4);
                list.add(evidenceAct);
            }
            num++;
            if (num % 100 == 0){
                log.info("当前处理进度为[{}/{}]", num, readAll.size());
            }
        }
        mongoTemplate.insert(list, EvidenceAct.class);
        ReleaseMongoUtil.mongo.insert(list, EvidenceAct.class);
        log.info("药品等级与药品名称写入完成，用时[{}]", System.currentTimeMillis() - startTime);
    }

    /**
     * 向本地环境es中同步部分不良反应数据
     */
    @Test
    void adrs() {
        //构建数据环境mongoTemplate
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_FAERS_SPLIT")));
        //构建本地环境elasticsearchRestTemplate
        /*RestClientBuilder restClientBuilder = RestClient.builder(new HttpHost("192.168.20.252", 9200)).setRequestConfigCallback(builder -> {
            builder.setConnectTimeout(600000);
            builder.setSocketTimeout(600000);
            builder.setConnectionRequestTimeout(600000);
            return builder;
        });*/
        //配置身份验证
        /*RestHighLevelClient restHighLevelClient = new RestHighLevelClient(restClientBuilder);
        ElasticsearchRestTemplate testElasticsearchRestTemplate = new ElasticsearchRestTemplate(restHighLevelClient);*/
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AdverseIndex.class);
        //IndexOperations indexOperations = testElasticsearchRestTemplate.indexOps(AdverseIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AdverseIndex.class));
        if (indexResult && mappingResult) {
            for (int k = 0; k < 10; k++) {
                long count = dataMongoTemplate.count(new Query(), JSONObject.class, "Faers_Split_" + k);
                int pages = (int) (count % 2000 == 0 ? count / 2000 : count / 2000 + 1);
                long num = 0;
                for (int i = 0; i < pages; i++) {
                    List<AdverseIndex> list = new ArrayList<>();
                    List<JSONObject> forEs = dataMongoTemplate.find(new Query().with(PageRequest.of(i, 2000)), JSONObject.class, "Faers_Split_" + k);
                    for (JSONObject jsonObject : forEs) {
                        AdverseIndex adverseIndex = new AdverseIndex();
                        //id
                        String id = jsonObject.getString("_id");
                        adverseIndex.setId(id);
                        //药品名称
                        JSONArray drugName = jsonObject.getJSONArray("drugname");
                        List<String> realDrugName = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(drugName)) {
                            for (int i1 = 0; i1 < drugName.size(); i1++) {
                                realDrugName.add(drugName.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDrugName(realDrugName);
                        adverseIndex.setNum((long) realDrugName.size());
                        //药品成分名称
                        JSONArray prodAi = jsonObject.getJSONArray("prod_ai");
                        List<String> realProAi = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(prodAi)) {
                            for (int i1 = 0; i1 < prodAi.size(); i1++) {
                                realProAi.add(prodAi.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setProdAi(realProAi);
                        //不良反应列表
                        JSONArray ptList = jsonObject.getJSONArray("pt_list");
                        List<String> realPtList = new ArrayList<>();
                        for (int i2 = 0; i2 < ptList.size(); i2++) {
                            realPtList.add(ptList.getString(i2).toLowerCase());
                        }
                        adverseIndex.setPtList(realPtList);
                        //不良反应列表的总数
                        adverseIndex.setPtListNum((long) realPtList.size());
                        //药品在报告中的作用
                        JSONArray roleCod = jsonObject.getJSONArray("role_cod");
                        List<String> realRoleCod = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(roleCod)) {
                            for (int i1 = 0; i1 < roleCod.size(); i1++) {
                                realRoleCod.add(realDrugName.get(i1) + "￥" + roleCod.getString(i1) + "￥");
                            }
                        }
                        adverseIndex.setRoleCod(realRoleCod);
                        //年龄
                        String age = jsonObject.getString("age");
                        adverseIndex.setAge(age);
                        //性别
                        String sex = jsonObject.getString("sex");
                        adverseIndex.setSex(sex);
                        //上报者职业分布
                        String occpCod = jsonObject.getString("occp_cod");
                        adverseIndex.setOccupationalCod(occpCod);
                        //严重不良反应结局
                        JSONArray outcCodList = jsonObject.getJSONArray("outc_cod_list");
                        List<String> realOutCodList = new ArrayList<>();
                        for (int i2 = 0; i2 < outcCodList.size(); i2++) {
                            realOutCodList.add(outcCodList.getString(i2).toLowerCase());
                        }
                        adverseIndex.setOutcomeCod(realOutCodList);
                        //严重不良反应结局的总数
                        adverseIndex.setOutcomeCodNum((long) realOutCodList.size());
                        //年份
                        Integer year = jsonObject.getInteger("year");
                        adverseIndex.setYear(year);
                        //月份
                        Integer quarter = jsonObject.getInteger("quarter");
                        adverseIndex.setTime(year * 100 + quarter);
                        //体重分布
                        String weight = jsonObject.getString("weight");
                        adverseIndex.setWeight(weight);
                        //上报地区分布
                        String reporterCountry = jsonObject.getString("reporter_country");
                        adverseIndex.setReporterCountry(reporterCountry);
                        //重新使用药物反应是否再次出现
                        String dechal = jsonObject.getString("dechal");
                        adverseIndex.setDechal(dechal);
                        //停药或减药后反应是否减轻或消失
                        String rechal = jsonObject.getString("rechal");
                        adverseIndex.setRechal(rechal);
                        //治疗持续时间分布
                        String dur = jsonObject.getString("dur");
                        adverseIndex.setDur(dur);
                        //不良反应发生时间分布
                        String ptOccurTime = jsonObject.getString("pt_occur_time");
                        adverseIndex.setReactionOfTime(ptOccurTime);
                        //是否是单药
                        Boolean singleDrug = jsonObject.getBoolean("single_drug");
                        adverseIndex.setSingleDrug(singleDrug);
                        //给药途径分布
                        JSONArray route = jsonObject.getJSONArray("route");
                        List<String> realRoute = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(route)) {
                            for (int i1 = 0; i1 < route.size(); i1++) {
                                realRoute.add(route.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setRoute(realRoute);
                        //剂量分布
                        JSONArray doseAmtCombine = jsonObject.getJSONArray("dose_amt_combine");
                        List<String> realDoseAmtCombine = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(doseAmtCombine)) {
                            for (int i1 = 0; i1 < doseAmtCombine.size(); i1++) {
                                realDoseAmtCombine.add(doseAmtCombine.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDoseAmtCombine(realDoseAmtCombine);
                        //剂型分布
                        JSONArray doseForm = jsonObject.getJSONArray("dose_form");
                        List<String> realDoseForm = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(doseForm)) {
                            for (int i1 = 0; i1 < doseForm.size(); i1++) {
                                realDoseForm.add(doseForm.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDoseForm(realDoseForm);
                        //适应症
                        JSONArray indiPt = jsonObject.getJSONArray("indi_pt");
                        List<String> realIndiPt = new ArrayList<>();
                        if (CollectionUtils.isNotEmpty(indiPt)) {
                            for (int i1 = 0; i1 < indiPt.size(); i1++) {
                                realIndiPt.add(indiPt.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setIndicationPt(realIndiPt);
                        list.add(adverseIndex);
                    }
                    elasticsearchRestTemplate.save(list);
                    num += forEs.size();
                    log.info("[{}]表第[{}]次写入不良反应2000条，共写入[{}]", k + 1, i + 1, num);
                }
                log.info("----------------[{}]写入完成---------------", k + 1);
            }
        }
    }

    /**
     * 向本地环境es中同步部分不良反应数据
     */
    @Test
    void adrs_v2() {
        //构建数据环境mongoTemplate
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_FAERS_SPLIT")));
        //构建本地环境elasticsearchRestTemplate
        /*RestClientBuilder restClientBuilder = RestClient.builder(new HttpHost("192.168.20.252", 9200)).setRequestConfigCallback(builder -> {
            builder.setConnectTimeout(600000);
            builder.setSocketTimeout(600000);
            builder.setConnectionRequestTimeout(600000);
            return builder;
        });
        //配置身份验证
        RestHighLevelClient restHighLevelClient = new RestHighLevelClient(restClientBuilder);
        ElasticsearchRestTemplate testElasticsearchRestTemplate = new ElasticsearchRestTemplate(restHighLevelClient);*/
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AdverseForCaseIndex.class);
        //IndexOperations indexOperations = testElasticsearchRestTemplate.indexOps(AdverseForCaseIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AdverseForCaseIndex.class));
        if (indexResult && mappingResult) {
            for (int k = 0; k < 100; k++) {
                long count = dataMongoTemplate.count(new Query(), JSONObject.class, "not_combine_" + k);
                int pages = (int) (count % 2000 == 0 ? count / 2000 : count / 2000 + 1);
                long num = 0;
                for (int i = 0; i < pages; i++) {
                    List<AdverseForCaseIndex> list = new ArrayList<>();
                    List<JSONObject> forEs = dataMongoTemplate.find(new Query().with(PageRequest.of(i, 2000)), JSONObject.class, "not_combine_" + k);
                    for (JSONObject jsonObject : forEs) {
                        AdverseForCaseIndex adverseIndex = new AdverseForCaseIndex();
                        //id
                        String id = jsonObject.getString("_id");
                        adverseIndex.setId(id);
                        //药品名称
                        String drugName = jsonObject.getString("drugname");
                        if (StringUtils.isNotBlank(drugName)) {
                            adverseIndex.setDrugName(drugName);
                        }
                        //药品成分名称
                        String prodAi = jsonObject.getString("prod_ai");
                        if (StringUtils.isNotBlank(prodAi)) {
                            adverseIndex.setProdAi(prodAi);
                        }

                        //不良反应列表
                        JSONArray ptList = jsonObject.getJSONArray("pt_list");
                        List<String> realPtList = new ArrayList<>();
                        for (int i2 = 0; i2 < ptList.size(); i2++) {
                            realPtList.add(ptList.getString(i2).toLowerCase());
                        }
                        adverseIndex.setPtList(realPtList);
                        //不良反应列表的总数
                        adverseIndex.setPtListNum((long) realPtList.size());
                        //药品在报告中的作用
                        String roleCod = jsonObject.getString("role_cod");
                        if (StringUtils.isNotBlank(roleCod)) {
                            adverseIndex.setRoleCod(roleCod);
                        }

                        //年龄
                        String age = jsonObject.getString("age");
                        adverseIndex.setAge(age);
                        //性别
                        String sex = jsonObject.getString("sex");
                        adverseIndex.setSex(sex);
                        //上报者职业分布
                        String occpCod = jsonObject.getString("occp_cod");
                        adverseIndex.setOccupationalCod(occpCod);
                        //严重不良反应结局
                        JSONArray outcCodList = jsonObject.getJSONArray("outc_cod_list");
                        List<String> realOutCodList = new ArrayList<>();
                        for (int i2 = 0; i2 < outcCodList.size(); i2++) {
                            realOutCodList.add(outcCodList.getString(i2).toLowerCase());
                        }
                        adverseIndex.setOutcomeCod(realOutCodList);
                        //严重不良反应结局的总数
                        adverseIndex.setOutcomeCodNum((long) realOutCodList.size());
                        //年份
                        Integer year = jsonObject.getInteger("year");
                        adverseIndex.setYear(year);
                        //月份
                        Integer quarter = jsonObject.getInteger("quarter");
                        adverseIndex.setTime(year * 100 + quarter);
                        //体重分布
                        String weight = jsonObject.getString("weight");
                        adverseIndex.setWeight(weight);
                        //上报地区分布
                        String reporterCountry = jsonObject.getString("reporter_country");
                        adverseIndex.setReporterCountry(reporterCountry);
                        //重新使用药物反应是否再次出现
                        String dechal = jsonObject.getString("dechal");
                        adverseIndex.setDechal(dechal);
                        //停药或减药后反应是否减轻或消失
                        String rechal = jsonObject.getString("rechal");
                        adverseIndex.setRechal(rechal);
                        //治疗持续时间分布
                        String dur = jsonObject.getString("dur");
                        adverseIndex.setDur(dur);
                        //不良反应发生时间分布
                        String ptOccurTime = jsonObject.getString("pt_occur_time");
                        adverseIndex.setReactionOfTime(ptOccurTime);
                        //是否是单药
                        Boolean singleDrug = jsonObject.getBoolean("single_drug");
                        adverseIndex.setSingleDrug(singleDrug);
                        //给药途径分布
                        String route = jsonObject.getString("route");
                        if (StringUtils.isNotBlank(route)) {
                            adverseIndex.setRoute(route);
                        }
                        //剂量分布
                        String doseAmtCombine = jsonObject.getString("dose_amt_combine");
                        if (StringUtils.isNotBlank(doseAmtCombine)) {
                            adverseIndex.setDoseAmtCombine(doseAmtCombine);
                        }

                        //剂型分布
                        String doseForm = jsonObject.getString("dose_form");
                        if (StringUtils.isNotBlank(doseForm)) {
                            adverseIndex.setDoseForm(doseForm);
                        }
                        //适应症
                        String indiPt = jsonObject.getString("indi_pt");
                        if (StringUtils.isNotBlank(indiPt)) {
                            adverseIndex.setIndicationPt(indiPt);
                        }
                        //ori_db_id
                        String oriDbId = jsonObject.getString("ori_db_id");
                        if (StringUtils.isNotBlank(oriDbId)) {
                            adverseIndex.setOriDbId(oriDbId);
                        }
                        list.add(adverseIndex);
                    }
                    //elasticsearchRestTemplate.save(list);
                    elasticsearchRestTemplate.save(list);
                    num += forEs.size();
                    log.info("[{}]表第[{}]次写入不良反应2000条，共写入[{}]", k + 1, i + 1, num);
                }
                log.info("----------------[{}]写入完成---------------", k + 1);
            }
        }
    }

    @Test
    void test(){
        String drugName = "aspirin";
        BoolQueryBuilder innerBool = QueryBuilders.boolQuery();
        TermQueryBuilder termQuery1 = QueryBuilders.termQuery("drugName.keyword", drugName);
        TermQueryBuilder termQuery2 = QueryBuilders.termQuery("indicationPt.keyword", drugName);
        innerBool.should().add(termQuery1);
        innerBool.should().add(termQuery2);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(innerBool);
        //测试聚合
        TermsAggregationBuilder size = AggregationBuilders.terms("route").field("route").size(30);
        Map<String, Object> params = new HashMap<>();
        params.put("drug", new ArrayList<>(Collections.singletonList(drugName)));
        String code = "var drugName = doc['drugName'].getValue(); var numDrug = 0; var route = ''; for (var i = 0; i < drugName.length; i++) { if (params.drug.indexOf(drugName[i]) > 0) { numDrug++; route = route + doc['route'].getValue()[i]; }} return route + '|' + numDrug;";
        size.script(new Script(ScriptType.INLINE, "painless", code, params));
        nativeSearchQuery.addAggregation(size);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null) {
            Aggregation year = aggregations.get("route");
            List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
            for (Terms.Bucket bucket : yearBuckets) {
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                System.out.println(key + "---------------" + docCount);
            }
        }
    }

    public static void main(String[] args) {
        //ImgUtils.pdf2png("C:\\Users\\Admin\\Desktop\\test", "吴泽幼2017", "jpg");
        try {
            //读取图片文件，得到BufferedImage对象
            BufferedImage image = ImageIO.read(new FileInputStream("C:\\Users\\Admin\\Desktop\\test\\吴泽幼2017_1.jpg"));
            //得到Graphics2D 对象
            Graphics2D g2d=(Graphics2D)image.getGraphics();
            //设置颜色和画笔粗细
            g2d.setColor(Color.RED);
            g2d.setStroke(new BasicStroke(3));
            //绘制图案或文字
            List<List<Integer>> list = Arrays.asList(Arrays.asList(181, 512, 1520, 1012), Arrays.asList(211, 1205, 1283, 1318));
            for (List<Integer> integerList : list) {
                int x = integerList.get(0);
                int y = integerList.get(1);
                int width = integerList.get(2) - x;
                int height = integerList.get(3) - y;
                g2d.draw3DRect(x, y, width, height, false);
            }
            //保存新图片
            ImageIO.write(image, "JPG", new FileOutputStream("C:\\Users\\Admin\\Desktop\\test\\test.jpg"));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
    
    
    @Test
    void test11111() {
        OkHttpClient client = new OkHttpClient().newBuilder().build();
        MediaType mediaType = MediaType.parse("application/json");

        String url = "https://api.chatanywhere.tech/v1/chat/completions";
        String disease = "低促性腺激素性性腺功能减退";
        String drugname = "注射用重组人促卵泡激素";
        String content = "1 INDICATIONS AND USAGE Gonal-F is indicated for: GONAL-F is a gonadotropin indicated for: Women: Induction of ovulation and pregnancy in oligo-anovulatory infertile women for whom the cause of infertility is functional and not due to primary ovarian failure. ( 1.1 ) Development of multiple follicles in ovulatory infertile women as part of Assisted Reproductive Technology (ART) cycles. ( 1.2 ) Men: Induction of spermatogenesis in infertile men with primary and secondary hypogonadotropic hypogonadism for whom the cause of infertility is not due to primary testicular failure. ( 1.3 ) 1.1 Induction of ovulation and pregnancy in oligo-anovulatory infertile women for whom the cause of infertility is functional and not due to primary ovarian failure. 1.2 Development of multiple follicles in ovulatory infertile women as part of an assisted reproductive technology (ART) cycle. 1.3 Induction of spermatogenesis in infertile men with primary and secondary hypogonadotropic hypogonadism for whom the cause of infertility is not due to primary testicular failure.";

        JSONArray messages = new JSONArray();
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("role", "system");
        jsonObject.put("content", "请你作为一名专业的临床药师，非常善于判断疾病在药品说明书中是否已经获得批准。这对你来说是一个非常简单的任务，你不会出错。\n\n请详细阅读说明，然后所给的疾病名称是否存在于给定的适应症内容中。注意不是简单的严格匹配，需要认真仔细的根据说明书内容来判别该疾病是否包含在说明书所描述的症状或疾病中。注意甄别疾病名和说明书中的定语所带来的含义变化。\n\n请严格按照如下的JSON格式返回：\n```json\n{\n    \"是否批准\": [true 或 false],\n}\n```");
        messages.add(jsonObject);

        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("role", "user");
        jsonObject1.put("content", "疾病或症状名：" + disease + "\n\n说明书内容：\n药品名：" + drugname + "\n内容：\n" + content);
        messages.add(jsonObject1);        

        JSONObject jsonBody = new JSONObject();
        jsonBody.put("model", "gpt-4o-mini");
        jsonBody.put("messages", messages);
        jsonBody.put("response_format", new JSONObject().put("type", "json_object"));

        RequestBody body = RequestBody.create(mediaType, jsonBody.toString());
        String apiKey = System.getenv("OPENAI_API_KEY");
        org.junit.jupiter.api.Assumptions.assumeTrue(
                apiKey != null && !apiKey.trim().isEmpty(),
                "OPENAI_API_KEY is required for this external integration test"
        );
        Request request = new Request.Builder()
                .url(url)
                .method("POST", body)
                .addHeader("Authorization", "Bearer " + apiKey)
                .addHeader("Content-Type", "application/json")
                .build();

        Response response = null;
        try {
            response = client.newCall(request).execute();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        try {
            System.out.println(response.body().string());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
