package com.sentum.evidencecomprehensive;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.poi.excel.ExcelReader;
import cn.hutool.poi.excel.ExcelUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.domain.*;
import com.sentum.evidencecomprehensive.domain.dto.FormatDataDTO;
import com.sentum.evidencecomprehensive.domain.dto.ai.GuideDS;
import com.sentum.evidencecomprehensive.domain.es.*;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.mongo.report.EssentialMedicines;
import com.sentum.evidencecomprehensive.service.impl.ReportServiceImpl;
import com.sentum.evidencecomprehensive.utils.DataMongoUtil;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.TransUtil;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.IdsQueryBuilder;
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
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@SpringBootTest
class EvidenceBasedApplicationTests {

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
    ReportServiceImpl reportService;
    
    private static final List<String> CHARACTER_STR = Arrays.asList("-", "--", "---", "----");
    
    
    @Test
    void test1() {
        String test = "{\n" +
                "  \"result\": [\n" +
                "    {\n" +
                "      \"title\": \"2020 Update of the EULAR Recommendations for the Management of Systemic Lupus Erythematosus\",\n" +
                "      \"content\": \"该指南提供了系统性红斑狼疮（SLE）管理的最新建议，特别是在药物治疗方面。贝利尤单抗（Belimumab）作为治疗SLE的生物制剂，在指南中被推荐用于那些对其他标准治疗反应不足的患者。重点章节包括药物治疗选择和患者个体化治疗策略。\",\n" +
                "      \"publish\": \"2020\",\n" +
                "      \"organ\": \"European League Against Rheumatism (EULAR)\",\n" +
                "      \"url\": \"https://ard.bmj.com/content/79/6/685\"\n" +
                "    },\n" +
                "    {\n" +
                "      \"title\": \"American College of Rheumatology Guideline for the Screening, Treatment, and Management of Lupus Nephritis\",\n" +
                "      \"content\": \"本指南专注于狼疮性肾炎的筛查、治疗和管理。贝利尤单抗在治疗狼疮性肾炎中作为辅助治疗被提及，特别是在减少肾损伤和改善患者长期预后方面。关键内容涉及药物治疗的最新进展和治疗方案的优化。\",\n" +
                "      \"publish\": \"2020\",\n" +
                "      \"organ\": \"American College of Rheumatology (ACR)\",\n" +
                "      \"url\": \"https://www.rheumatology.org/Portals/0/Files/ACR%20Guideline%20for%20Lupus%20Nephritis_2020.pdf\"\n" +
                "    },\n" +
                "    {\n" +
                "      \"title\": \"British Society for Rheumatology Guideline for the Management of Systemic Lupus Erythematosus in Adults\",\n" +
                "      \"content\": \"该指南为英国成人系统性红斑狼疮的管理提供建议。贝利尤单抗在指南中作为一种有效的生物治疗方法被推荐，特别是在治疗那些对传统疗法反应不佳的患者中。相关章节讨论了药物的适应症、疗效和安全性。\",\n" +
                "      \"publish\": \"2018\",\n" +
                "      \"organ\": \"British Society for Rheumatology\",\n" +
                "      \"url\": \"https://academic.oup.com/rheumatology/article/57/suppl_5/key440/5056115\"\n" +
                "    },\n" +
                "    {\n" +
                "      \"title\": \"Japan College of Rheumatology Guideline for the Management of Systemic Lupus Erythematosus\",\n" +
                "      \"content\": \"日本风湿病学会发布的系统性红斑狼疮管理指南详细介绍了贝利尤单抗在治疗SLE中的应用。指南强调其在减少疾病活动度和改善生活质量方面的效果，并提供了详细的治疗方案和患者监测建议。\",\n" +
                "      \"publish\": \"2019\",\n" +
                "      \"organ\": \"Japan College of Rheumatology\",\n" +
                "      \"url\": \"https://www.jstage.jst.go.jp/article/internmed/58/3/58_558/_article\"\n" +
                "    },\n" +
                "    {\n" +
                "      \"title\": \"Systemic Lupus Erythematosus: Practice Essentials, Pathophysiology, Etiology\",\n" +
                "      \"content\": \"这篇文章是系统性红斑狼疮的临床实践指南，涵盖病理生理学、病因学和治疗管理。贝利尤单抗作为现代化疗药物之一，在减少疾病复发和改善患者长期健康状况方面被广泛讨论。重点内容包括药物治疗的最新研究和临床应用。\",\n" +
                "      \"publish\": \"2021\",\n" +
                "      \"organ\": \"Medscape\",\n" +
                "      \"url\": \"https://emedicine.medscape.com/article/332244-overview\"\n" +
                "    }\n" +
                "  ]\n" +
                "}";

        List<GuideDS> guideDSResult = new ArrayList<>();
        JSONObject obj = JSONObject.parseObject(test);
        JSONArray result = obj.getJSONArray("result");
        result.forEach(o -> {
            String jsonString = JSON.toJSONString(o);
            GuideDS guideDS = JSON.parseObject(jsonString, GuideDS.class);
            guideDSResult.add(guideDS);
        });
        System.out.println();
        System.out.println();
        System.out.println();
        System.out.println();
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
     * 新爬的 英文同义词库
     */
    @Test
    void newMesh_20241125() {
        int pageSize = 1000;
        long countEn = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "mesh_new_zong_250109");
        log.info("-----开始更新英文mesh数据共[{}]-----", countEn);
        int numEn = (int) (countEn%pageSize==0?countEn/pageSize:countEn/pageSize+1);
        for (int i = 0; i < numEn; i++) {
            List<EvidenceMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "mesh_new_zong_250109");
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

                String name = jsonObject.getString("name");
                if (StringUtils.isBlank(name)){
                    name = "";
                }
                //入口词
                JSONArray entryTermsArray = jsonObject.getJSONArray("yingwen_entry_word");
                List<String> entryTerms = new ArrayList<>();
                if (CollUtil.isNotEmpty(entryTermsArray)){
                    entryTerms = entryTermsArray.stream().map(String::valueOf).map(String::toLowerCase).distinct().collect(Collectors.toList());
                    if (StrUtil.isNotBlank(name)) {
                        entryTerms.add(name.toLowerCase());
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
//            mongoTemplate.insert(list, EvidenceMesh.class);
            ReleaseMongoUtil.mongo.insert(list, EvidenceMesh.class);
            log.info("---------------英文mesh第[{}]次写入1000条------------------", i+1);
        }
    }

    /**
     * 新爬的 英文同义词库
     */
    @Test
    void newCMesh_20241125() {
        int pageSize = 1000;
        long countEn = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "cmesh_new_zh_quchongg_250109");
        log.info("-----开始更新中文cMesh数据共[{}]-----", countEn);
        int numEn = (int) (countEn%pageSize==0?countEn/pageSize:countEn/pageSize+1);
        for (int i = 0; i < numEn; i++) {
            List<EvidenceCMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "cmesh_new_zh_quchongg_250109");
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
                String nameZh = jsonObject.getString("name");
                if (StringUtils.isBlank(nameZh)){
                    nameZh = "";
                }
                cMesh.setNameZh(nameZh.trim());
                //英文
                String nameEn = jsonObject.getString("English_name");
                if (StringUtils.isBlank(nameEn)){
                    nameEn = "";
                }
                cMesh.setNameEn(nameEn.toLowerCase());

                //入口词
                Set<String> set = new HashSet<>();
                Set<String> setZh = new HashSet<>();
                Set<String> setEn = new HashSet<>();
                Set<String> setOther = new HashSet<>();
                if (StringUtils.isNotBlank(nameZh)){
                    set.add(nameZh.toLowerCase().trim());
                    setZh.add(nameZh.toLowerCase().trim());
                }
                
                JSONArray entryTermsArray = jsonObject.getJSONArray("entryTerms");
                List<String> entryTerms;
                if (CollUtil.isNotEmpty(entryTermsArray)){
                    entryTerms = entryTermsArray.stream().map(String::valueOf).map(String::toLowerCase).map(str -> str.replaceAll("\\u00A0", "")).collect(Collectors.toList());
                    set.addAll(entryTerms);
                }
                cMesh.setEntryTerms(new ArrayList<>(set));
                
                JSONArray zhongwne_entry_word = jsonObject.getJSONArray("zhongwne_entry_word");
                List<String> zhEntryTerms;
                if (CollUtil.isNotEmpty(zhongwne_entry_word)){
                    zhEntryTerms = zhongwne_entry_word.stream().map(String::valueOf).map(String::toLowerCase).map(str -> str.replaceAll("\\u00A0", "")).collect(Collectors.toList());
                    setZh.addAll(zhEntryTerms);
                }
                cMesh.setZhEntryTerms(new ArrayList<>(setZh));
                
                JSONArray yingwen_entry_word = jsonObject.getJSONArray("yingwen_entry_word");
                List<String> enEntryTerms;
                if (CollUtil.isNotEmpty(yingwen_entry_word)){
                    enEntryTerms = yingwen_entry_word.stream().map(String::valueOf).map(String::toLowerCase).map(str -> str.replaceAll("\\u00A0", "")).collect(Collectors.toList());
                    setEn.addAll(enEntryTerms);
                }
                cMesh.setEnEntryTerms(new ArrayList<>(setEn));
                
                JSONArray qita_entry_word = jsonObject.getJSONArray("qita_entry_word");
                List<String> otherEntryTerms;
                if (CollUtil.isNotEmpty(qita_entry_word)){
                    otherEntryTerms = qita_entry_word.stream().map(String::valueOf).map(String::toLowerCase).map(str -> str.replaceAll("\\u00A0", "")).collect(Collectors.toList());
                    setOther.addAll(otherEntryTerms);
                }
                cMesh.setOtherEntryTerms(new ArrayList<>(setOther));
                
                //树形结构编码
                String treeNumber = jsonObject.getString("Tree_structure_number");
                if (StringUtils.isBlank(treeNumber)){
                    treeNumber = "";
                }
                cMesh.setTreeNumber(treeNumber);
                list.add(cMesh);
            }
//            mongoTemplate.insert(list, EvidenceCMesh.class);
            ReleaseMongoUtil.mongo.insert(list, EvidenceCMesh.class);
            log.info("---------------中文cmesh第[{}]次写入1000条------------------", i+1);
        }
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
     *
     */
    @Test
    void registerNo() {
        int pageSize = 1000;
        long count = ReleaseMongoUtil.mongo.count(new Query(), JSONObject.class, "clinical_trial_registration_withResults");
        log.info("-----开始更新中文临床试验数据共[{}]-----", count);
        int num = (int) (count%pageSize==0?count/pageSize:count/pageSize+1);
        for (int i = 0; i < num; i++) {
            List<JSONObject> objectList = ReleaseMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "clinical_trial_registration_withResults");
            for (int i1 = 0; i1 < objectList.size(); i1++) {
                JSONObject jsonObject = objectList.get(i1);
                if (Objects.isNull(jsonObject.getString("study_results"))) continue;
                String study_results = jsonObject.getString("study_results");
                if (Objects.isNull(jsonObject.getString("register_no"))) continue;
                String register_no = jsonObject.getString("register_no");
                List<JSONObject> jsonObjects = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("register_no")), JSONObject.class, "clinical_trial_registration_new");
                System.out.println();
            }
            log.info("---------------中文临床试验第[{}]次写入1000条------------------", i+1);
        }
    }

    /**
     * 合理用药说明书数据
     */
    @Test
    void medicine() {
        int pageSize = 300;
        long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "medication_assistant_rational_use");
        log.info("-----合理用药说明书数据导入开始，共计[{}]条数据-----", count);
        int num = (int) (count%pageSize==0?count/pageSize:count/pageSize+1);
        for (int i = 0; i < num; i++) {
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "medication_assistant_rational_use");
            List<JSONObject> saveData = new ArrayList<>();
            for (JSONObject jsonObject : objectList) {
                JSONObject innerObj = new JSONObject();

                String id = jsonObject.getString("_id");
                if (StrUtil.isBlank(id)) {
                    continue;
                }

                innerObj.put("_id", id);

                // 药品名称
                String inn_name = jsonObject.getString("inn_name");
                if (StrUtil.isNotBlank(inn_name)) {
                    innerObj.put("drugName", inn_name);
                }

                //肝功能不全者剂量调整
                JSONArray doseAdjustmentPatientsWithLiverDysfunction = jsonObject.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction");
                if (CollUtil.isNotEmpty(doseAdjustmentPatientsWithLiverDysfunction)) {
                    innerObj.put("doseAdjustmentPatientsWithLiverDysfunction", doseAdjustmentPatientsWithLiverDysfunction);
                }

                //肾功能不全
                JSONArray doseAdjustmentPatientsWithRenalInsufficiency = jsonObject.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency");
                if (CollUtil.isNotEmpty(doseAdjustmentPatientsWithRenalInsufficiency)) {
                    innerObj.put("doseAdjustmentPatientsWithRenalInsufficiency", doseAdjustmentPatientsWithRenalInsufficiency);
                }

                // 适应症与用法用量
                JSONArray indicationsDosage = new JSONArray();
                if (CollUtil.isNotEmpty(jsonObject.getJSONArray("indicationsDosage"))) {
                    indicationsDosage.addAll(jsonObject.getJSONArray("indicationsDosage"));
                }
                JSONArray conventionalMedication = jsonObject.getJSONArray("conventionalMedication");
                JSONArray elderlyDoseAdjustment = jsonObject.getJSONArray("elderlyDoseAdjustment");

                if (CollUtil.isNotEmpty(conventionalMedication)) {
                    indicationsDosage.addAll(conventionalMedication);
                }
                if (CollUtil.isNotEmpty(doseAdjustmentPatientsWithLiverDysfunction)) {
                    indicationsDosage.addAll(doseAdjustmentPatientsWithLiverDysfunction);
                }
                if (CollUtil.isNotEmpty(doseAdjustmentPatientsWithRenalInsufficiency)) {
                    indicationsDosage.addAll(doseAdjustmentPatientsWithRenalInsufficiency);
                }
                if (CollUtil.isNotEmpty(elderlyDoseAdjustment)) {
                    indicationsDosage.addAll(elderlyDoseAdjustment);
                }
                if (CollUtil.isNotEmpty(indicationsDosage)) {
                    innerObj.put("indicationsDosage", indicationsDosage);
                }

                // 药理作用
                JSONArray pharmacology = jsonObject.getJSONArray("pharmacology");
                if (CollUtil.isNotEmpty(pharmacology)) {
                    innerObj.put("pharmacology", pharmacology);
                }

                // 药代动力学
                JSONArray pharmacokinetics = jsonObject.getJSONArray("pharmacokinetics");
                JSONArray pharmacodynamics = jsonObject.getJSONArray("pharmacodynamics");
//                JSONArray pharmacokinetics = jsonObject.getJSONArray("pharmacokinetics");
                if (CollUtil.isNotEmpty(pharmacodynamics)) {
                    pharmacokinetics.addAll(pharmacodynamics);
                }
                if (CollUtil.isNotEmpty(pharmacokinetics)) {
                    innerObj.put("pharmacokinetics", pharmacokinetics);
                }

                // 黑框警告
                JSONArray blackBoxWaringOfFDA = jsonObject.getJSONArray("blackBoxWaringOfFDA");
                if (CollUtil.isNotEmpty(blackBoxWaringOfFDA)) {
                    innerObj.put("warning", blackBoxWaringOfFDA);
                }

                // 老人与儿童用药
                JSONArray medicationElderlyPatientsOrMedicationPediatricPatients = jsonObject.getJSONArray("medicationElderlyPatientsOrMedicationPediatricPatients");
                if (CollUtil.isNotEmpty(medicationElderlyPatientsOrMedicationPediatricPatients)) {
                    innerObj.put("childrenAndGeriatricMedicine", medicationElderlyPatientsOrMedicationPediatricPatients);
                }

                // 老人与儿童用药
                JSONArray medicationPediatricPatients = jsonObject.getJSONArray("medicationPediatricPatients");
                if (CollUtil.isNotEmpty(medicationPediatricPatients)) {
                    innerObj.put("children", medicationPediatricPatients);
                }

                // 哺乳期用药
                JSONArray medicationDuringLactation = jsonObject.getJSONArray("medicationDuringLactation");
                if (CollUtil.isNotEmpty(medicationDuringLactation)) {
                    innerObj.put("medicationDuringLactation", medicationDuringLactation);
                }

                // 妊娠期用药
                JSONArray medicationDuringPregnancy = jsonObject.getJSONArray("medicationDuringPregnancy");
                if (CollUtil.isNotEmpty(medicationDuringPregnancy)) {
                    innerObj.put("medicationDuringPregnancy", medicationDuringPregnancy);
                }

                // 禁忌
                JSONArray contraindications = jsonObject.getJSONArray("contraindications");
                if (CollUtil.isNotEmpty(contraindications)) {
                    innerObj.put("taboo", contraindications);
                }

                // 注意事项
                JSONArray notes = jsonObject.getJSONArray("notes");
                if (CollUtil.isNotEmpty(notes)) {
                    innerObj.put("notes", notes);
                }

                // 注意事项
                JSONArray interaction = jsonObject.getJSONArray("interaction");
                if (CollUtil.isNotEmpty(interaction)) {
                    innerObj.put("interaction", interaction);
                }

                // 贮藏
                JSONArray storage = jsonObject.getJSONArray("storage");
                if (CollUtil.isNotEmpty(storage)) {
                    innerObj.put("storage", storage);
                }

                //常见不良反应
                JSONArray commonAdverseReactions = jsonObject.getJSONArray("commonAdverseReactions");
                if (CollUtil.isNotEmpty(commonAdverseReactions)) {
                    innerObj.put("commonAdverseReactions", commonAdverseReactions);
                }

                //严重不良反应
                JSONArray seriousAdverseRactions = jsonObject.getJSONArray("seriousAdverseRactions");
                if (CollUtil.isNotEmpty(seriousAdverseRactions)) {
                    innerObj.put("seriousAdverseRactions", seriousAdverseRactions);
                }

                //不良反应
                JSONArray adverseReaction = new JSONArray();
                if (CollUtil.isNotEmpty(commonAdverseReactions)) {
                    adverseReaction.addAll(commonAdverseReactions);
                }
                if (CollUtil.isNotEmpty(seriousAdverseRactions)) {
                    adverseReaction.addAll(seriousAdverseRactions);
                }
                if (CollUtil.isNotEmpty(adverseReaction)) {
                    innerObj.put("adverseReaction", adverseReaction);
                }
                saveData.add(innerObj);
            }
            ReleaseMongoUtil.mongo.insert(saveData, "evaluation_medicine6");
            log.info("---------------合理用药说明书数据第[{}]次写入300条------------------", i+1);
        }
        log.info("--------------合理用药说明书数据导入完成------------------");
    }

    /**
     * 说明书原文数据
     */
    @Test
    void instruction() {
        int pageSize = 1000;
        long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "medication_assistant_instructions_use");
        log.info("-----用药助手说明书数据导入开始，共计[{}]条数据-----", count);
        int num = (int) (count%pageSize==0?count/pageSize:count/pageSize+1);
        for (int i = 0; i < num; i++) {
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "medication_assistant_instructions_use");
            List<JSONObject> saveData = new ArrayList<>();
            for (JSONObject jsonObject : objectList) {
                JSONObject innerObj = new JSONObject();

                String id = jsonObject.getString("_id");
                if (StrUtil.isBlank(id)) {
                    continue;
                }
                innerObj.put("_id", id);

                // 药品名称 成分 五级中文
                String innName = jsonObject.getString("innName");
                if (StrUtil.isNotBlank(innName)) {
                    innerObj.put("name", innName);
                }

                // 药品名称
                String commonName = jsonObject.getString("commonName");
                if (StrUtil.isNotBlank(commonName)) {
                    innerObj.put("drugName", commonName);
                }

                // 适应症
                JSONArray indication = jsonObject.getJSONArray("indication");
                if (CollUtil.isNotEmpty(indication)) {
                    innerObj.put("indication", indication);
                }

                // 用法用量
                JSONArray dosage = jsonObject.getJSONArray("dosage");
                if (CollUtil.isNotEmpty(dosage)) {
                    innerObj.put("dosage", dosage);
                }

                // 药理作用
                JSONArray mechanismAction = jsonObject.getJSONArray("mechanismAction");
                if (CollUtil.isNotEmpty(mechanismAction)) {
                    innerObj.put("pharmacology", mechanismAction);
                }

                // 药代动力学
                JSONArray pharmacokinetics = jsonObject.getJSONArray("pharmacokinetics");
                if (CollUtil.isNotEmpty(pharmacokinetics)) {
                    innerObj.put("pharmacokinetics", pharmacokinetics);
                }

                // 黑框警告
                JSONArray drugWarning = jsonObject.getJSONArray("drugWarning");
                if (CollUtil.isNotEmpty(drugWarning)) {
                    innerObj.put("warning", drugWarning);
                }

                // 儿童用药
                JSONArray useInChildren = jsonObject.getJSONArray("useInChildren");
                if (CollUtil.isNotEmpty(useInChildren)) {
                    innerObj.put("children", useInChildren);
                }

                // 老人用药
                JSONArray useInElderly = jsonObject.getJSONArray("useInElderly");
                if (CollUtil.isNotEmpty(useInElderly)) {
                    innerObj.put("geriatrics", useInElderly);
                }

                // 妊娠期用药
                JSONArray useInPregLact = jsonObject.getJSONArray("useInPregLact");
                if (CollUtil.isNotEmpty(useInPregLact)) {
                    innerObj.put("medicationPregnancy", useInPregLact);
                }

                // 禁忌
                JSONArray contraindications = jsonObject.getJSONArray("contraindications");
                if (CollUtil.isNotEmpty(contraindications)) {
                    innerObj.put("taboo", contraindications);
                }

                // 注意事项
                JSONArray precautions = jsonObject.getJSONArray("precautions");
                if (CollUtil.isNotEmpty(precautions)) {
                    innerObj.put("notes", precautions);
                }

                // 相互作用
                JSONArray drugInteractions = jsonObject.getJSONArray("drugInteractions");
                if (CollUtil.isNotEmpty(drugInteractions)) {
                    innerObj.put("interaction", drugInteractions);
                }

                //不良反应
                JSONArray adverseReactions = jsonObject.getJSONArray("adverseReactions");
                if (CollUtil.isNotEmpty(adverseReactions)) {
                    innerObj.put("adverseReaction", adverseReactions);
                }
                saveData.add(innerObj);
            }
            ReleaseMongoUtil.mongo.insert(saveData, "evaluation_instructions_use");
            log.info("---------------用药助手说明书数据第[{}]次写入1000条------------------", i+1);
        }
        log.info("---------------用药助手说明书数据导入完成------------------");
    }

    /**
     * nmpa 说明书数据
     */
    @Test
    void instructionEs() {
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(InstructionsUseIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(InstructionsUseIndex.class));
        if (indexResult && mappingResult) {
            int pageSize = 1000;
            long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "instructions_nmpa");
            log.info("-----开始更新用药助手说明书数据共[{}]-----", count);
            int pages = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);
            
            Set<String> approveCodeSet = new HashSet<>();
            for (int i = 0; i < pages; i++) {
                List<InstructionsUseIndex> list = new ArrayList<>();
                List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "instructions_nmpa");
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
                        instructionsUseIndex.setApproveCode(content);
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

                    String approveCodeNMPA = jsonObject.getString("approveCodeNMPA");
                    if (StrUtil.isNotBlank(approveCodeNMPA)) {
                        DrugInfo drugInfo = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("register").is(approveCodeNMPA)), DrugInfo.class);
                        if (Objects.nonNull(drugInfo)) {
                            String drugInfoSpecifications = drugInfo.getSpecifications();
                            if (StrUtil.isNotBlank(drugInfoSpecifications) && !CHARACTER_STR.contains(drugInfoSpecifications)) {
                                specifications = new StringBuilder();
                                specifications.append(drugInfoSpecifications);
                            }
                        }
                        instructionsUseIndex.setSpecifications(specifications.toString());
                    }

                    

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
                log.info("---------------用药助手说明书数据第[{}]次写入500条------------------", i+1);
            }
        }
        log.info("---------------导入完成------------------");
    }

    /**
     * 药物警戒数据导入
     */
    @Test
    void pharmacovigilance() {
        int pageSize = 300;
        long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "sda_pharmacovigilance_upload");
        log.info("-----药物警戒数据导入开始，共计[{}]条数据-----", count);
        int num = (int) (count%pageSize==0?count/pageSize:count/pageSize+1);
        for (int i = 0; i < num; i++) {
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "sda_pharmacovigilance_upload");
            ReleaseMongoUtil.mongo.insert(objectList, "pharmacovigilance_new");
            System.out.println();
            log.info("---------------药物警戒数据第[{}]次写入300条------------------", i+1);
        }
        log.info("---------------药物警戒数据导入完成------------------");
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
                List<String> conditions = new ArrayList<>();
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
                //疾病
                String condition = jsonObject.getString("condition");
                String conditionEn = jsonObject.getString("condition_en");
                if (StrUtil.isNotBlank(condition)) conditions.add(condition);
                if (StrUtil.isNotBlank(conditionEn)) conditions.add(conditionEn);

                clinicalTrials.setIntervention(intervention);
                clinicalTrials.setOutcome(outcome);
                clinicalTrials.setConditions(conditions);
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
                List<String> conditions = new ArrayList<>();
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
                //研究疾病
                JSONArray condition = jsonObject.getJSONArray("condition");
                if (condition != null && CollUtil.isNotEmpty(condition)) {
                    for (int i1 = 0; i1 < condition.size(); i1++) {
                        conditions.add(String.valueOf(condition.get(i1)));
                    }
                }
                clinicalTrials.setIntervention(intervention);
                clinicalTrials.setOutcome(outcome);
                clinicalTrials.setConditions(conditions);
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
                        if (CollUtil.isNotEmpty(drugName)) {
                            for (int i1 = 0; i1 < drugName.size(); i1++) {
                                realDrugName.add(drugName.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDrugName(realDrugName);
                        adverseIndex.setNum((long) realDrugName.size());
                        //药品成分名称
                        JSONArray prodAi = jsonObject.getJSONArray("prod_ai");
                        List<String> realProAi = new ArrayList<>();
                        if (CollUtil.isNotEmpty(prodAi)) {
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
                        if (CollUtil.isNotEmpty(roleCod)) {
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
                        if (CollUtil.isNotEmpty(route)) {
                            for (int i1 = 0; i1 < route.size(); i1++) {
                                realRoute.add(route.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setRoute(realRoute);
                        //剂量分布
                        JSONArray doseAmtCombine = jsonObject.getJSONArray("dose_amt_combine");
                        List<String> realDoseAmtCombine = new ArrayList<>();
                        if (CollUtil.isNotEmpty(doseAmtCombine)) {
                            for (int i1 = 0; i1 < doseAmtCombine.size(); i1++) {
                                realDoseAmtCombine.add(doseAmtCombine.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDoseAmtCombine(realDoseAmtCombine);
                        //剂型分布
                        JSONArray doseForm = jsonObject.getJSONArray("dose_form");
                        List<String> realDoseForm = new ArrayList<>();
                        if (CollUtil.isNotEmpty(doseForm)) {
                            for (int i1 = 0; i1 < doseForm.size(); i1++) {
                                realDoseForm.add(doseForm.getString(i1).toLowerCase());
                            }
                        }
                        adverseIndex.setDoseForm(realDoseForm);
                        //适应症
                        JSONArray indiPt = jsonObject.getJSONArray("indi_pt");
                        List<String> realIndiPt = new ArrayList<>();
                        if (CollUtil.isNotEmpty(indiPt)) {
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
                        if (StrUtil.isNotBlank(drugName)) {
                            adverseIndex.setDrugName(drugName);
                        }
                        //药品成分名称
                        String prodAi = jsonObject.getString("prod_ai");
                        if (StrUtil.isNotBlank(prodAi)) {
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
                        if (StrUtil.isNotBlank(roleCod)) {
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
                        if (StrUtil.isNotBlank(route)) {
                            adverseIndex.setRoute(route);
                        }
                        //剂量分布
                        String doseAmtCombine = jsonObject.getString("dose_amt_combine");
                        if (StrUtil.isNotBlank(doseAmtCombine)) {
                            adverseIndex.setDoseAmtCombine(doseAmtCombine);
                        }

                        //剂型分布
                        String doseForm = jsonObject.getString("dose_form");
                        if (StrUtil.isNotBlank(doseForm)) {
                            adverseIndex.setDoseForm(doseForm);
                        }
                        //适应症
                        String indiPt = jsonObject.getString("indi_pt");
                        if (StrUtil.isNotBlank(indiPt)) {
                            adverseIndex.setIndicationPt(indiPt);
                        }
                        //ori_db_id
                        String oriDbId = jsonObject.getString("ori_db_id");
                        if (StrUtil.isNotBlank(oriDbId)) {
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
        try {
            //读取图片文件，得到BufferedImage对象
//            BufferedImage image = ImageIO.read(new FileInputStream("C:\\Users\\Admin\\Desktop\\test\\吴泽幼2017_1.jpg"));
            BufferedImage image = ImageIO.read(new FileInputStream("/Users/yyyyouhf/Desktop/pic/1.png"));
            //得到Graphics2D 对象
            Graphics2D g2d=(Graphics2D)image.getGraphics();
            //设置颜色和画笔粗细
            g2d.setColor(Color.RED);
            g2d.setStroke(new BasicStroke(3));
            //绘制图案或文字
//            List<List<Integer>> list = Arrays.asList(Arrays.asList(181, 512, 1520, 1012), Arrays.asList(211, 1205, 1283, 1318));
            List<List<Integer>> list = Arrays.asList(Arrays.asList(181, 512, 1520, 1012), Arrays.asList(211, 1205, 1283, 1318));
            for (List<Integer> integerList : list) {
                int x = integerList.get(0);
                int y = integerList.get(1);
                int width = integerList.get(2) - x;
                int height = integerList.get(3) - y;
                g2d.draw3DRect(x, y, width, height, false);
            }
            //保存新图片
//            ImageIO.write(image, "JPG", new FileOutputStream("C:\\Users\\Admin\\Desktop\\test\\test.jpg"));
            ImageIO.write(image, "PNG", new FileOutputStream("/Users/yyyyouhf/Desktop/pic/test.png"));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    /**
     * 向本地环境es中同步部分hta报告数据
     */
    @Test
    void hta() {
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(HtaReportIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(HtaReportIndex.class));
        if (indexResult && mappingResult) {
            int pageSize = 500;
            long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "result_hta_report_online");
            log.info("-----开始更新hta数据共[{}]-----", count);
            int numZh = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);
            for (int i = 0; i < numZh; i++) {
                List<HtaReportIndex> htaReportIndices = new ArrayList<>();
                List<HtaReport> htaReports = new ArrayList<>();
                List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "result_hta_report_online");
                for (JSONObject jsonObject : objectList) {
                    HtaReportIndex htaReportIndex = new HtaReportIndex();
                    HtaReport htaReport = new HtaReport();
                    // id
                    String id = jsonObject.getString("_id");
                    htaReportIndex.setId(id);
                    htaReport.setId(id);
                    // title
                    String title = jsonObject.getString("title");
                    htaReportIndex.setTitle(title);
                    htaReportIndex.setName(title);
                    htaReport.setTitle(title);
                    // link
                    String link = jsonObject.getString("link");
                    htaReportIndex.setLink(link);
                    htaReport.setLink(link);
                    // source
                    String source = jsonObject.getString("source");
                    htaReportIndex.setSource(source);
                    htaReport.setSource(source);
                    // sourceFull
                    String sourceFull = jsonObject.getString("sourceFull");
                    htaReportIndex.setSourceFull(sourceFull);
                    htaReport.setSource(source);
                    // 全文
                    if ("PBAC".equals(source)) {
                        String zhFullText = jsonObject.getString("zh_full_text");
                        if (StrUtil.isNotBlank(zhFullText)) {
                            htaReportIndex.setZhFullText(zhFullText);
                        }
                        String fullText = jsonObject.getString("full_text");
                        if (StrUtil.isNotBlank(fullText)) {
                            htaReportIndex.setFullText(fullText);
                        }
                    }
                    // exists_flag
                    int existsFlag = 0;  // 默认 0 无 pdf  ， 1为有 pdf 全文
                    if (Objects.nonNull(jsonObject.getInteger("existsFlag"))) {
                        existsFlag = jsonObject.getInteger("existsFlag");
                    }
                    htaReportIndex.setExistsFlag(existsFlag);
                    // pdfName
                    String pdfName = jsonObject.getString("pdfName");
                    htaReportIndex.setPdfName(pdfName);
                    htaReport.setPdfName(pdfName);
                    // publishTime
                    String publishTime = jsonObject.getString("publishTime");
                    htaReportIndex.setPublishTime(publishTime);
                    htaReport.setPublishTime(publishTime);
                    SimpleDateFormat simpleDateFormat_year = new SimpleDateFormat("yyyy");
                    SimpleDateFormat simpleDateFormat_year_month = new SimpleDateFormat("yyyy-MM");
                    SimpleDateFormat simpleDateFormat_year_month_day = new SimpleDateFormat("yyyy-MM-dd");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour = new SimpleDateFormat("yyyy-MM-dd HH");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour_mi = new SimpleDateFormat("yyyy-MM-dd HH:mm");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour_mi_se = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                    if (StrUtil.isNotBlank(publishTime)) {
                        if (publishTime.contains(":")) {
                            if (publishTime.indexOf(":") == publishTime.lastIndexOf(":")) {
                                try {
                                    long time = simpleDateFormat_year_month_day_hour_mi.parse(publishTime).getTime();
                                    htaReportIndex.setPublishTimeDateTs(time);
                                    htaReportIndices.add(htaReportIndex);
//                                    continue;
                                } catch (ParseException e) {
                                    log.error("parse error: " + e.getMessage());
                                }
                            } else {
                                try {
                                    long time = simpleDateFormat_year_month_day_hour_mi_se.parse(publishTime).getTime();
                                    htaReportIndex.setPublishTimeDateTs(time);
                                    htaReportIndices.add(htaReportIndex);
//                                    continue;
                                } catch (ParseException e) {
                                    log.error("parse error: " + e.getMessage());
                                }
                            }
                        }

                        if (publishTime.split(" ").length == 2) {
                            try {
                                long time = simpleDateFormat_year_month_day_hour.parse(publishTime).getTime();
                                htaReportIndex.setPublishTimeDateTs(time);
                                htaReportIndices.add(htaReportIndex);
//                                continue;
                            } catch (ParseException e) {
                                log.error("parse error: " + e.getMessage());
                            }
                        }

                        String[] split_ = publishTime.split("-");
                        try {
                            if (split_.length == 1) {
                                long time = simpleDateFormat_year.parse(publishTime).getTime();
                                htaReportIndex.setPublishTimeDateTs(time);
                                htaReportIndices.add(htaReportIndex);
//                                continue;
                            } else if (split_.length == 2) {
                                long time = simpleDateFormat_year_month.parse(publishTime).getTime();
                                htaReportIndex.setPublishTimeDateTs(time);
                                htaReportIndices.add(htaReportIndex);
//                                continue;
                            } else if (split_.length == 3) {
                                long time = simpleDateFormat_year_month_day.parse(publishTime).getTime();
                                htaReportIndex.setPublishTimeDateTs(time);
                                htaReportIndices.add(htaReportIndex);
//                                continue;
                            }
                        } catch (ParseException e) {
                            log.error("parse error: " + e.getMessage());
                        }
                    }
//                    htaReportIndex.setPublishTimeDateTs(0L);
                    htaReportIndices.add(htaReportIndex);


                    JSONArray pdfTagList = jsonObject.getJSONArray("pdf_tag_list");
                    if (CollUtil.isNotEmpty(pdfTagList)) {
                        htaReport.setPdfTagList(JSON.parseObject(JSON.toJSONString(pdfTagList), new TypeReference<List<String>>() {}));
                    }          
                    
                    JSONArray cleanImagePdfDataGptVerList = jsonObject.getJSONArray("clean_image_pdf_data_gpt_ver_list");
                    if (CollUtil.isNotEmpty(cleanImagePdfDataGptVerList)) {
                        htaReport.setCleanImagePdfDataGptVerList(JSON.parseObject(JSON.toJSONString(cleanImagePdfDataGptVerList), new TypeReference<List<String>>() {}));
                    }
                    
                    JSONArray wordCleanImagePdfDataGptVerList = jsonObject.getJSONArray("word_clean_image_pdf_data_gpt_ver_list");
                    if (CollUtil.isNotEmpty(wordCleanImagePdfDataGptVerList)) {
                        htaReport.setWordCleanImagePdfDataGptVerList(JSON.parseObject(JSON.toJSONString(wordCleanImagePdfDataGptVerList), new TypeReference<List<List<FormatDataDTO>>>() {}));
                    }

                    String security = jsonObject.getString("security");
                    if (StrUtil.isNotBlank(security)) {
                        htaReport.setSecurity(security);
                    }                   
                    
                    String effectiveness = jsonObject.getString("effectiveness");
                    if (StrUtil.isNotBlank(effectiveness)) {
                        htaReport.setEffectiveness(effectiveness);
                    }
                    
                    String economicViability = jsonObject.getString("economic_viability");
                    if (StrUtil.isNotBlank(economicViability)) {
                        htaReport.setEconomicViability(economicViability);
                    }
                    
                    String ethic = jsonObject.getString("ethic");
                    if (StrUtil.isNotBlank(ethic)) {
                        htaReport.setEthic(ethic);
                    }
                    
                    String doctorAdvice = jsonObject.getString("doctor_advice");
                    if (StrUtil.isNotBlank(doctorAdvice)) {
                        htaReport.setDoctorAdvice(doctorAdvice);
                    }
                    
                    String patientAdvice = jsonObject.getString("patient_advice");
                    if (StrUtil.isNotBlank(patientAdvice)) {
                        htaReport.setPatientAdvice(patientAdvice);
                    }
                    
                    String recommendedAdvice = jsonObject.getString("recommended_advice");
                    if (StrUtil.isNotBlank(recommendedAdvice)) {
                        htaReport.setRecommendedAdvice(recommendedAdvice);
                    }
                    htaReports.add(htaReport);
                }
                elasticsearchRestTemplate.save(htaReportIndices);
                ReleaseMongoUtil.mongo.insert(htaReports, "evidence_hta_20250922");
                log.info("---------------hta第[{}]次写入500条------------------", i+1);
            }
        }
        log.info("---------------导入完成------------------");
    }

    @Test
    void htaReoprt() {
        long count = DataMongoUtil.mongo.count(new Query(), HtaReport.class);
        if (count > 0) {
            int pages = (int) (count % 1000 == 0? count / 1000 :count / 1000 + 1);
            for (int i = 0; i < pages; i++) {
                Query query = new Query();
                query.with(PageRequest.of(i, 1000));
                List<HtaReport> htaReports = DataMongoUtil.mongo.find(query, HtaReport.class);
                if (CollUtil.isNotEmpty(htaReports)) {
                   ReleaseMongoUtil.mongo.insert(htaReports, "hta_report_bak");
                }
                log.info("---------------第{}条导入完成------------------", (i+1)*1000);
            }
        } 

        log.info("---------------导入完成------------------");
    }

    @Test
    void cdeData() {
        long count = DataMongoUtil.mongo.count(new Query(), CdeData.class);
        if (count > 0) {
            int pages = (int) (count % 1000 == 0? count / 1000 :count / 1000 + 1);
            for (int i = 0; i < pages; i++) {
                Query query = new Query();
                query.with(PageRequest.of(i, 1000));
                List<CdeData> cdeData = DataMongoUtil.mongo.find(query, CdeData.class);
                if (CollUtil.isNotEmpty(cdeData)) {
//                    ReleaseMongoUtil.mongo.insert(cdeData, CdeData.class);
                    ReleaseMongoUtil.mongo.insert(cdeData, "cde_data_bak_20250115");
                }
                log.info("---------------第{}条导入完成------------------", (i+1)*1000);
            }
        }

        log.info("---------------导入完成------------------");
    }

    @Test
    void result_hta_report() {
        long count = DataMongoUtil.mongo.count(new Query(), ResultHtaReport.class);
        if (count > 0) {
            int pages = (int) (count % 1000 == 0? count / 1000 :count / 1000 + 1);
            for (int i = 0; i < pages; i++) {
                Query query = new Query();
                query.with(PageRequest.of(i, 1000));
                List<ResultHtaReport> resultHtaReports = DataMongoUtil.mongo.find(query, ResultHtaReport.class);
                if (CollUtil.isNotEmpty(resultHtaReports)) {
                    ReleaseMongoUtil.mongo.insert(resultHtaReports, ResultHtaReport.class);
                }
                log.info("---------------result_hta_report第{}条导入完成------------------", (i+1)*1000);
            }
        }
        log.info("---------------result_hta_report导入完成------------------");
    }

    @Test
    void cdeIndexData() {
        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(CdeIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(CdeIndex.class));

        if (indexResult && mappingResult) {
            int pageSize = 100;
            long count = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "cde_data");
            log.info("-----开始更新cde数据共[{}]-----", count);
            int pages = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);
            for (int i = 0; i < pages; i++) {
                List<CdeIndex> list = new ArrayList<>();
                List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "cde_dataLogFactoryLogFactory");
                for (JSONObject jsonObject : objectList) {
                    CdeIndex cdeIndex = new CdeIndex();
                    // id
                    String id = jsonObject.getString("_id");
                    cdeIndex.setId(id);
                    // acceptid
                    String acceptid = jsonObject.getString("acceptid");
                    cdeIndex.setAcceptid(acceptid);
                    // drgnamecn
                    String drgnamecn = jsonObject.getString("drgnamecn");
                    cdeIndex.setDrgnamecn(drgnamecn);
                    // drugtype
                    String drugtype = jsonObject.getString("drugtype");
                    cdeIndex.setDrugtype(drugtype);
                    // registerkind
                    String registerkind = jsonObject.getString("registerkind");
                    cdeIndex.setRegisterkind(registerkind);
                    // company
                    String company = jsonObject.getString("clean_companys");
                    cdeIndex.setCompanys(company);
                    // pdfUrl1
                    String pdfUrl1 = jsonObject.getString("pdf_url1");
                    cdeIndex.setPdfUrl1(pdfUrl1);
                    // tableIndication
                    String indication = jsonObject.getString("table_indication");
                    cdeIndex.setIndication(indication);

                    List<String> component = new ArrayList<>();
                    JSONArray englishComponent = jsonObject.getJSONArray("english_component");
                    if (CollUtil.isNotEmpty(englishComponent)) {
                        List<String> english_component = JSON.parseObject(JSON.toJSONString(englishComponent), new TypeReference<List<String>>() {
                        });
                        english_component = english_component.stream().map(String::toLowerCase).collect(Collectors.toList());
                        component.addAll(english_component);
                    }
                    JSONArray englishComponentSynonyms = jsonObject.getJSONArray("english_component_synonyms");
                    if (CollUtil.isNotEmpty(englishComponentSynonyms)) {
                        List<String> english_component_synonyms = JSON.parseObject(JSON.toJSONString(englishComponentSynonyms), new TypeReference<List<String>>() {
                        });
                        english_component_synonyms = english_component_synonyms.stream().map(String::toLowerCase).collect(Collectors.toList());
                        component.addAll(english_component_synonyms);
                    }

                    JSONArray chineseComponent = jsonObject.getJSONArray("chinese_component");
                    if (CollUtil.isNotEmpty(chineseComponent)) {
                        List<String> chinese_component = JSON.parseObject(JSON.toJSONString(chineseComponent), new TypeReference<List<String>>() {
                        });
                        chinese_component = chinese_component.stream().map(String::toLowerCase).collect(Collectors.toList());
                        component.addAll(chinese_component);
                    }
                    JSONArray chineseComponentSynonyms = jsonObject.getJSONArray("chinese_component_synonyms");
                    if (CollUtil.isNotEmpty(chineseComponentSynonyms)) {
                        List<String> chinese_component_synonyms = JSON.parseObject(JSON.toJSONString(chineseComponentSynonyms), new TypeReference<List<String>>() {
                        });
                        chinese_component_synonyms = chinese_component_synonyms.stream().map(String::toLowerCase).collect(Collectors.toList());
                        component.addAll(chinese_component_synonyms);
                    }
                    cdeIndex.setComponent(component);
                    
                    // createddate
                    String date = jsonObject.getString("createddate");
                    cdeIndex.setDate(date);
                    SimpleDateFormat simpleDateFormat_year = new SimpleDateFormat("yyyy");
                    SimpleDateFormat simpleDateFormat_year_month = new SimpleDateFormat("yyyy-MM");
                    SimpleDateFormat simpleDateFormat_year_month_day = new SimpleDateFormat("yyyy-MM-dd");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour = new SimpleDateFormat("yyyy-MM-dd HH");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour_mi = new SimpleDateFormat("yyyy-MM-dd HH:mm");
                    SimpleDateFormat simpleDateFormat_year_month_day_hour_mi_se = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                    if (StrUtil.isNotBlank(date)) {
                        if (date.contains(":")) {
                            if (date.indexOf(":") == date.lastIndexOf(":")) {
                                try {
                                    long time = simpleDateFormat_year_month_day_hour_mi.parse(date).getTime();
                                    cdeIndex.setDateTimeDateTs(time);
                                    list.add(cdeIndex);
                                    continue;
                                } catch (ParseException e) {
                                    log.error("parse error: " + e.getMessage());
                                }
                            } else {
                                try {
                                    long time = simpleDateFormat_year_month_day_hour_mi_se.parse(date).getTime();
                                    cdeIndex.setDateTimeDateTs(time);
                                    list.add(cdeIndex);
                                    continue;
                                } catch (ParseException e) {
                                    log.error("parse error: " + e.getMessage());
                                }
                            }
                        }

                        if (date.split(" ").length == 2) {
                            try {
                                long time = simpleDateFormat_year_month_day_hour.parse(date).getTime();
                                cdeIndex.setDateTimeDateTs(time);
                                list.add(cdeIndex);
                                continue;
                            } catch (ParseException e) {
                                log.error("parse error: " + e.getMessage());
                            }
                        }

                        String[] split_ = date.split("-");
                        try {
                            if (split_.length == 1) {
                                long time = simpleDateFormat_year.parse(date).getTime();
                                cdeIndex.setDateTimeDateTs(time);
                                list.add(cdeIndex);
                                continue;
                            } else if (split_.length == 2) {
                                long time = simpleDateFormat_year_month.parse(date).getTime();
                                cdeIndex.setDateTimeDateTs(time);
                                list.add(cdeIndex);
                                continue;
                            } else if (split_.length == 3) {
                                long time = simpleDateFormat_year_month_day.parse(date).getTime();
                                cdeIndex.setDateTimeDateTs(time);
                                list.add(cdeIndex);
                                continue;
                            }
                        } catch (ParseException e) {
                            log.error("parse error: " + e.getMessage());
                        }
                        log.error(date + " is not in a recognized format.");
                    }
                    cdeIndex.setDateTimeDateTs(0L);
                    list.add(cdeIndex);
                }
                elasticsearchRestTemplate.save(list);
                log.info("---------------cde第[{}]次写入100条------------------", i+1);
            }
        }
        log.info("---------------导入完成------------------");
    }

    @Test
    void ctg_studies() {
        long count = DataMongoUtil.mongo.count(new Query(), clinicalTrialOutcomeData.class);
        if (count > 0) {
            int pages = (int) (count % 1000 == 0? count / 1000 :count / 1000 + 1);
            for (int i = 0; i < pages; i++) {
                Query query = new Query();
                query.with(PageRequest.of(i, 1000));
                List<clinicalTrialOutcomeData> clinicalTrialOutcomeData = DataMongoUtil.mongo.find(query, clinicalTrialOutcomeData.class);
                if (CollUtil.isNotEmpty(clinicalTrialOutcomeData)) {
                    ReleaseMongoUtil.mongo.insert(clinicalTrialOutcomeData, clinicalTrialOutcomeData.class);
                }
                log.info("---------------ctg_studies第{}条导入完成------------------", (i+1)*1000);
            }
        }

        log.info("---------------ctg_studies导入完成------------------");
    }
    
    @Test
    void clinicalsChiSample() {
        Query query = new Query();
        query.addCriteria(Criteria.where("belong").is("chictr"));
        long count = ReleaseMongoUtil.mongo.count(query, ClinicalTrialRegistration.class);
        List<ClinicalIndex> clinicalIndices = new ArrayList<>();
        if (count > 0) {
            int pages = (int) (count % 1000 == 0 ? count / 1000 : count / 1000 + 1);
            for (int i = 0; i < pages; i++) {
                query.with(PageRequest.of(i, 1000));
                List<ClinicalTrialRegistration> clinicalTrialRegistrations = ReleaseMongoUtil.mongo.find(query, ClinicalTrialRegistration.class);
                // 查询es中 chictr的数据
                IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
                idsQueryBuilder.addIds(clinicalTrialRegistrations.stream().map(ClinicalTrialRegistration::getId).toArray(String[]::new));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
                nativeSearchQuery.setMaxResults(1000);
                SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
                for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
                    ClinicalIndex content = clinicalIndexSearchHit.getContent();
                    ClinicalTrialRegistration registration = ReleaseMongoUtil.mongo.findById(content.getId(), ClinicalTrialRegistration.class);
                    if (Objects.nonNull(registration)) {
                        if(Objects.nonNull(registration.getBelong()) && "chictr".equals(registration.getBelong())){
                            List<Map<String, Object>> intervention = registration.getIntervention();
                            if(CollUtil.isNotEmpty(intervention)){
                                int sum = 0;
                                for(Map<String, Object> map : intervention){
                                    String string = map.get("sample_size").toString();
                                    sum += Integer.parseInt(string);
                                }
                                content.setSampleSize(sum+"");
                                clinicalIndices.add(content);
                            } else {
                                log.info("-----------数据无intervention-----------------");
                            }
                        } else {
                            log.info("-----------数据为空-----------------");
                        }
                    } else {
                        log.info("-----------数据为空-----------------");
                    }
                }
                log.info("-----------数据完成{}条-----------------", (i+1)*1000);
            }
        }
        
        
        if (CollUtil.isNotEmpty(clinicalIndices)) {
            int countUpdate = 0;
            log.info("-------------开始进行更新-------------------");
            for (ClinicalIndex clinicalIndex : clinicalIndices) {
                String delete = elasticsearchRestTemplate.delete(clinicalIndex);
                elasticsearchRestTemplate.save(clinicalIndex);
                countUpdate++;
                if (countUpdate % 1000 == 0) log.info("------------{}条数据更新完成----------", countUpdate);
            }
        }
    }

    @Test
    void testTrans() {
        String s = TransUtil.trans("阿司匹林");
        System.out.println(s);
    }

    /**
     * 将原始数据库中的mesh和cMesh更新到测试与正式环境
     */
    @Test
    void newMesh(){
        //异常数据
        List<String> removeList = new ArrayList<>(Arrays.asList("2-", "4-", "α-", "β-"));
        int pageSize = 1000;
        long countZh = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "cmesh_new_zh_quchong");
        log.info("-----开始更新中文cMesh数据共[{}]-----", countZh);
        int numZh = (int) (countZh%pageSize==0?countZh/pageSize:countZh/pageSize+1);
        for (int i = 0; i < numZh; i++) {
            List<EvidenceCMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "cmesh_new_zh_quchong");
            for (JSONObject jsonObject : objectList) {
                EvidenceCMesh cMesh = new EvidenceCMesh();
                //id
                cMesh.setId(UUID.randomUUID().toString());
                //主题词
                String title = jsonObject.getString("name");
                if (StringUtils.isBlank(title)){
                    title = "";
                }
                cMesh.setTitle(title);
                //中文
                String nameZh = jsonObject.getString("name");
                if (StringUtils.isBlank(nameZh)){
                    nameZh = "";
                }
                cMesh.setNameZh(nameZh);
                //英文
                String nameEn = jsonObject.getString("英文名称");
                if (StringUtils.isBlank(nameEn)){
                    nameEn = "";
                }
                cMesh.setNameEn(nameEn);
                //入口词
                String kuanmc = jsonObject.getString("款目词");
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
                setZh.removeAll(removeList);
                cMesh.setEntryTerms(new ArrayList<>(setZh));
                //树形结构编码
                String treeNumber = jsonObject.getString("树状结构号");
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
        long countEn = DataMongoUtil.mongo.count(new Query(), JSONObject.class, "mesh_new");
        log.info("-----开始更新英文mesh数据共[{}]-----", countEn);
        int numEn = (int) (countEn%pageSize==0?countEn/pageSize:countEn/pageSize+1);
        for (int i = 0; i < numEn; i++) {
            List<EvidenceMesh> list = new ArrayList<>();
            List<JSONObject> objectList = DataMongoUtil.mongo.find(new Query().with(PageRequest.of(i, pageSize)), JSONObject.class, "mesh_new");
            for (JSONObject jsonObject : objectList) {
                EvidenceMesh mesh = new EvidenceMesh();
                //id
                mesh.setId(UUID.randomUUID().toString());
                //主题词
                String title = jsonObject.getString("name");
                if (StringUtils.isBlank(title)){
                    title = "";
                }
                mesh.setTitle(title);
                //入口词
                JSONArray originalEntryTerms = jsonObject.getJSONArray("entry_terms");
                List<String> entryTerms = new ArrayList<>();
                if (StringUtils.isNotBlank(title)){
                    entryTerms.add(title.toLowerCase());
                }
                if (CollUtil.isNotEmpty(originalEntryTerms)){
                    for (int i1 = 0; i1 < originalEntryTerms.size(); i1++) {
                        String txt = originalEntryTerms.getString(i1);
                        if (StringUtils.isNotBlank(txt)){
                            txt = StrUtil.trim(txt);
                            entryTerms.add(txt.toLowerCase().trim());
                        }
                    }
                }
                entryTerms.removeAll(removeList);
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
     * 国家基本药物
     */
    @Test
    void essentialMedicines() {
        long count = DataMongoUtil.mongo.count(new Query(), EssentialMedicines.class, "national_essential_medicine_list");
        if (count > 0) {
            int pages = (int) (count % 100 == 0? count / 100 :count / 100 + 1);
            for (int i = 0; i < pages; i++) {
                Query query = new Query();
                query.with(PageRequest.of(i, 100));
                List<EssentialMedicines> essentialMedicines = DataMongoUtil.mongo.find(query, EssentialMedicines.class, "national_essential_medicine_list");
                if (CollUtil.isNotEmpty(essentialMedicines)) {
//                    ReleaseMongoUtil.mongo.insert(essentialMedicines, EssentialMedicines.class);
                    ReleaseMongoUtil.mongo.insert(essentialMedicines, "national_essential_medicines_information_1029");
                }
                log.info("---------------essential_medicines第{}条导入完成------------------", (i+1)*100);
            }
        }
        log.info("---------------essential_medicines导入完成------------------");
    }
}
