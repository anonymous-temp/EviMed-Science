package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.lowagie.text.Font;
import com.lowagie.text.Image;
import com.lowagie.text.*;
import com.lowagie.text.rtf.RtfWriter2;
import com.lowagie.text.rtf.field.RtfPageNumber;
import com.lowagie.text.rtf.field.RtfTotalPageNumber;
import com.lowagie.text.rtf.headerfooter.RtfHeaderFooter;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.domain.mongo.PaperIncludeOrExclude;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang.exception.ExceptionUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Service
@Slf4j
public class SuperManualReportServiceImpl implements SuperManualReportService {
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private AdverseService adverseService;
    @Autowired
    private PaperService paperService;
    @Autowired
    private ClinicalTrialsService clinicalTrialsService;
    @Autowired
    private GuideService guideService;
    @Autowired
    private QuestionService questionService;
    /**
     * 文心一言服务
     * @param msg content
     * @return 返回结果
     */
    private String wenChat(String msg, Integer type){
        log.info("query:{}",msg);
        try {
            ERNIE_Bot bot = new ERNIE_Bot();
            return bot.chat(msg, type);
        }catch (Exception e){
            log.error(e.getMessage(),e);
            return "";
        }
    }

    @Override
    public JSONObject create(String id, Long userId, HttpServletRequest request) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        //判断是否是默认生成报告
        JSONObject report = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
        if (report == null) {
            //开始默认纳入逻辑
//            paperService.defaultInclusion(id, userId);
//            clinicalTrialsService.defaultInclusion(id, userId);
            guideService.defaultInclusion(id, userId);
            questionService.create(id, userId, request);
        } else {
            //保存课题历史
            questionService.insertHistory(id);
        }
        JSONObject result = new JSONObject();
       
        //开始创建报告
        long startTime = System.currentTimeMillis();
        //id
        result.put("_id", id);
        //标题
        result.put("title", getInfo(condition) + "超说明书用药循证报告");
        //获取不良反应数据
        JSONObject adverseInfo = adverseService.info(id);
        //获取纳入文献数据
        Query paperQuery = new Query(Criteria.where("conditionId").is(id).and("status").is(1));
        paperQuery.with(Sort.by(Sort.Direction.DESC, "timeStamp"));
        List<PaperIncludeOrExclude> include = mongoTemplate.find(paperQuery, PaperIncludeOrExclude.class);
        List<MongoLiterature> mongoLiteratures = new ArrayList<>();
        for (PaperIncludeOrExclude paperIncludeOrExclude : include) {
            MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(paperIncludeOrExclude.getPaperId(), MongoLiterature.class, "mongo_literature_" + Math.abs(paperIncludeOrExclude.getPaperId().hashCode()) % 10);
            if (mongoLiterature != null) {
                mongoLiteratures.add(mongoLiterature);
            }
        }
        //一、背景：
        result.put("background", background(condition, adverseInfo));
        //二、有效性循证结果：
        result.put("effective", effective(condition, mongoLiteratures));
        //三、安全性循证结果：
        result.put("safety", safety(condition, adverseInfo));
        //四、参考文献：
        result.put("references", references(mongoLiteratures));
        //推荐等级
        result.put("levelJudge", levelJudge(mongoLiteratures));
        log.info("[{}]报告生成完成，用时[{}]", id, System.currentTimeMillis() - startTime);
        Query query = new Query(Criteria.where("_id").is(id));
        boolean exists = mongoTemplate.exists(query, JSONObject.class, "super_manual_Report");
        if (exists) {
            mongoTemplate.remove(query, JSONObject.class, "super_manual_Report");
        }
        mongoTemplate.save(result, "super_manual_Report");
        return result;
    }

    @Override
    public JSONObject show(String id) {
        return mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
    }

    @Override
    public void download(String id, HttpServletResponse response) {
        log.info("开始下载报告");
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        JSONObject superManualReport = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
        if (superManualReport == null) {
            throw new RuntimeException("报告id异常");
        }
        String title = superManualReport.getString("title");
        String fileName = title + ".doc";
        response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
        try {
            ServletOutputStream outputStream = response.getOutputStream();
            Document document = new Document(PageSize.A4);
            document.setMargins(50, 50, 50, 50);
            RtfWriter2.getInstance(document, outputStream);
            document.open();
            //标题 等级
            Font firstFont = new Font(null, 32, Font.BOLD);
            setFirstTitle("\n\n" + title, document, firstFont);
            Font gradeFont = new Font(null, 14, Font.BOLD);
            JSONObject levelJudge = superManualReport.getJSONObject("levelJudge");
            String recommendLevel = levelJudge.getString("recommendLevel");
            String evidenceLevel = levelJudge.getString("evidenceLevel");
            setFirstTitle("\n推荐等级："+recommendLevel + "级    证据等级：" + evidenceLevel, document, gradeFont);
            document.newPage();
            //一、背景：
            setTitle("一、背景：", document);
            JSONObject background = superManualReport.getJSONObject("background");
            //1、阿司匹林临床研究概述
            JSONObject backgroundOne = background.getJSONObject("one");
            String backgroundTitle1 = backgroundOne.getString("title");
            setTitle(backgroundTitle1, document);
            String backgroundData1 = backgroundOne.getString("data");
            setContent(backgroundData1, document);
            //2、冠心病的治疗进展
            JSONObject backgroundTwo = background.getJSONObject("two");
            String backgroundTitle2 = backgroundTwo.getString("title");
            setTitle(backgroundTitle2, document);
            String backgroundData2 = backgroundTwo.getString("data");
            setContent(backgroundData2, document);
            //3、阿司匹林治疗冠心病
            JSONObject backgroundThree = background.getJSONObject("three");
            String backgroundTitle3 = backgroundThree.getString("title");
            setTitle(backgroundTitle3, document);
            String backgroundData3 = backgroundThree.getString("data");
            setContent(backgroundData3, document);
            //4、待评价药品介绍
            JSONObject backgroundFour = background.getJSONObject("four");
            String backgroundTitle4 = backgroundFour.getString("title");
            setTitle(backgroundTitle4, document);
            JSONArray backgroundData4 = backgroundFour.getJSONArray("data");
            for (int i = 0; i < backgroundData4.size(); i++) {
                JSONObject jsonObject = backgroundData4.getJSONObject(i);
                String name = jsonObject.getString("name");
                setTitle("4."+name, document);
                String indications = jsonObject.getString("indications");
                if (StringUtils.isBlank(indications)) {
                    indications = "暂无";
                }
                String usageAndDosage = jsonObject.getString("usageAndDosage");
                if (StringUtils.isBlank(usageAndDosage)) {
                    usageAndDosage = "暂无";
                }
                setNormalTitle("（1）适应症：" + indications, document);
                setNormalTitle("（2）用法用量：" + usageAndDosage, document);
            }
            //二、有效性循证结果：
            setTitle("二、有效性循证结果：", document);
            JSONObject effective = superManualReport.getJSONObject("effective");
            //1、说明书查询结果：
            JSONObject effectiveOne = effective.getJSONObject("one");
            String effectiveTitle1 = effectiveOne.getString("title");
            setTitle(effectiveTitle1, document);
            String effectiveData1 = effectiveOne.getString("data");
            setContent(effectiveData1, document);
            //2、指南/共识循证结果：
            JSONObject effectiveTwo = effective.getJSONObject("two");
            String effectiveTitle2 = effectiveTwo.getString("title");
            setTitle(effectiveTitle2, document);
            JSONArray effectiveData2 = effectiveTwo.getJSONArray("data");
            for (int i = 0; i < effectiveData2.size(); i++) {
                JSONObject jsonObject = effectiveData2.getJSONObject(i);
                String innerTitle = jsonObject.getString("title");
                setTitle("（"+(i+1) + "）" +innerTitle, document);
                String innerData = jsonObject.getString("data");
                if (StringUtils.isNotBlank(innerData)) {
                    setContent(innerData, document);
                }
            }
            //3、文献资料循证结果：
            JSONObject effectiveThree = effective.getJSONObject("three");
            String effectiveTitle3 = effectiveThree.getString("title");
            setTitle(effectiveTitle3, document);
            JSONArray data = effectiveThree.getJSONArray("data");
            if (CollUtil.isNotEmpty(data)) {
                for (Object o : data) {
                    String content = JSON.parseObject(JSON.toJSONString(o), new TypeReference<String>() {
                    });
                    setContent(content, document);
                }
            } else {
                setContent("暂无内容", document);
            }
//            String effectiveData3 = effectiveThree.getString("data");
//            setContent(effectiveData3, document);
            //三、安全性循证结果：
            setTitle("三、安全性循证结果：", document);
            JSONObject safety = superManualReport.getJSONObject("safety");
            //1、说明书中安全性相关信息：
            setTitle("1、说明书中安全性相关信息：", document);
            JSONArray safetyOne = safety.getJSONArray("one");
            for (int i = 0; i < safetyOne.size(); i++) {
                JSONObject jsonObject = safetyOne.getJSONObject(i);
                String name = jsonObject.getString("name");
                setTitle("1."+(i+1)+name, document);
                setNormalTitle("（1）禁忌：", document);
                setContent(jsonObject.getString("taboo"), document);
                setNormalTitle("（2）孕妇及哺乳期妇女：", document);
                setContent(jsonObject.getString("women"), document);
                setNormalTitle("（3）儿童用药：", document);
                setContent(jsonObject.getString("children"), document);
                setNormalTitle("（4）老年用药：", document);
                setContent(jsonObject.getString("old"), document);
                setNormalTitle("（5）肝肾功能不全：", document);
                setContent(jsonObject.getString("liverFunction"), document);
                setNormalTitle("（6）注意事项：", document);
                setContent(jsonObject.getString("notes"), document);
                setNormalTitle("（7）不良反应：", document);
                setContent(jsonObject.getString("adverse"), document);
            }
            //2、政策分析：
            setTitle("2、政策分析：", document);
            JSONArray safetyTwo = safety.getJSONArray("two");
            for (int i = 0; i < safetyTwo.size(); i++) {
                JSONObject jsonObject = safetyTwo.getJSONObject(i);
                String innerTitle = jsonObject.getString("title");
                if (innerTitle.contains("药监局暂未公布")) {
                    setContent(innerTitle, document);
                } else {
                    String innerTime = jsonObject.getString("time");
                    setNormalTitle("（" + (i + 1) + "）" + innerTitle + (StringUtils.isNotBlank(innerTime) ? "-" + innerTime : ""), document);
                    JSONArray content = jsonObject.getJSONArray("content");
                    for (int i1 = 0; i1 < content.size(); i1++) {
                        String string = content.getString(i1);
                        setContent(string, document);
                    }
                }
            }
            //3、FAERS数据库分析：
            setTitle("3、FAERS数据库分析：", document);
            JSONObject safetyThree = safety.getJSONObject("three");
            setContent(safetyThree.getString("adverse"), document);
            setContent(safetyThree.getString("calculateTypicalSignals"), document);
            //四、参考文献：
            setTitle("四、参考文献：", document);
            JSONArray references = superManualReport.getJSONArray("references");
            for (int i = 0; i < references.size(); i++) {
                setContent(references.getString(i), document);
            }
            //五、附录：
            document.newPage();
            setTitle("五、附录：", document);
            setTitle("附录一、“推荐等级”评价标准", document);
            Paragraph blankSpace = new Paragraph("");
            Font blankSize = new Font(null, 12, Font.NORMAL);
            blankSpace.setFont(blankSize);
            for (int i = 0; i < 1; i++) {
                document.add(blankSpace);
            }
            Image image = null;
            try {
                //添加图片
                ClassPathResource classPathResource = new ClassPathResource("/image/recommendCriteria.jpg");
                InputStream inputStreamImg = classPathResource.getInputStream();
                BufferedImage read = ImageIO.read(inputStreamImg);
                //通过将文件转换为临时文件进行操作
                File imgFile = File.createTempFile("recommendCriteria", ".jpg");
                ImageIO.write(read, "jpg", imgFile);
                image = Image.getInstance(String.valueOf(imgFile));
            } catch (Exception e) {
                log.error("读取图片文件出现异常，{}", ExceptionUtils.getFullStackTrace(e));
            }
            if (image != null) {
                image.setAlignment(Element.ALIGN_LEFT);
                //依照比例缩放
                image.scalePercent(71f);
                // 设置图片的显示大小
                //image1.scaleToFit(700, 871);
                image.setSpacingBefore(20f);
                document.add(image);
            }
            //设置页面
            setPageNum(document);
            document.close();
            log.info("报告下载完成");
        } catch (IOException | DocumentException e) {
            e.printStackTrace();
        }
    }

    /**
     * 根据检索条件获取模板数据  在XX（药名）治疗XX（病名）
     * @param condition 检索条件
     * @return 模板数据
     */
    private String getInfo(Condition condition) {
        StringBuilder info = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
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
        return info.toString();
    }

    private void formatLogs(String path, String question, String answer) {
        log.info("文心一言：path=[{}] -----> [{}] -----> [{}]", path, question, answer);
    }

    private JSONObject levelJudge(List<MongoLiterature> mongoLiteratures) {
        JSONObject result = new JSONObject();
        // 推荐等级
        String recommendLevel = "--";
        // 证据等级
        String evidenceLevel = "--";
        int count_4 = 0;
        int count_7 = 0;

        // 找到一个最高推荐等级  数字越小等级越高
        Map<Integer, String> level = new HashMap<>();
        level.put(100, "--" + ";" + "--");  // 给一个默认值

        if (CollUtil.isNotEmpty(mongoLiteratures)) {
            for (MongoLiterature mongoLiterature : mongoLiteratures) {
                if (StrUtil.isBlank(mongoLiterature.getQuality())) {
                    continue;
                }
                if (CollUtil.isEmpty(mongoLiterature.getType())) {
                    continue;
                }

                // 质量高 的 系统/Meta分析 ｜｜ 质量高的 Review
                String quality = mongoLiterature.getQuality();
                List<Integer> type = mongoLiterature.getType();
                if (("2".equals(quality) && CollUtil.contains(type, 3))
                        || ("2".equals(quality) && CollUtil.contains(type, 0))) {
                    evidenceLevel = "I a";
                    recommendLevel = "A";
                    level.put(1, "I a" + ";" + "A");
                    continue;
                }

                // 多项质量等级中的 RCT/nRCT
                if ("1".equals(quality) && CollUtil.contains(type, 4)) {
                    if (count_4 == 2) {
                        evidenceLevel = "I a";
                        recommendLevel = "A";
                        level.put(1, "I a" + ";" + "A");
                        count_4 = 0;
                        continue;
                    }
                    count_4++;
                }

                // 多项质量等级中的 临床试验
                if ("1".equals(quality) && CollUtil.contains(type, 7)) {
                    if (count_7 == 2) {
                        evidenceLevel = "I a";
                        recommendLevel = "A";
                        level.put(1, "I a" + ";" + "A");
                        count_7 = 0;
                        continue;
                    }
                    count_7++;
                }

                // 质量等级高的RCT/nRCT  ｜｜ 质量等级高的 临床试验
                if (("2".equals(quality) && CollUtil.contains(type, 4))
                        || ("2".equals(quality) && CollUtil.contains(type, 7))) {
                    evidenceLevel = "I b";
                    recommendLevel = "A";
                    level.put(2, "I b" + ";" + "A");
                    continue;
                }

                // 质量等级中的 Review
                if (("1".equals(quality) && CollUtil.contains(type, 0))) {
                    evidenceLevel = "II a";
                    recommendLevel = "B";
                    level.put(3, "II a" + ";" + "B");
                    continue;
                }

                // 质量低的RCT ｜｜ 质量低 的临床试验 ｜｜ 质量中或高的 Meta
                if (("0".equals(quality) && CollUtil.contains(type, 4))
                        || ("0".equals(quality) && CollUtil.contains(type, 7))
                        || ("1".equals(quality) && CollUtil.contains(type, 3))
                        || ("0".equals(quality) && CollUtil.contains(type, 3))) {
                    evidenceLevel = "II b";
                    recommendLevel = "B";
                    level.put(4, "II b" + ";" + "B");
                    continue;
                }

                // 质量高中的观察研究 ｜｜ 质量高中的病例
                if (("2".equals(quality) && CollUtil.contains(type, 5))
                        || ("1".equals(quality) && CollUtil.contains(type, 5))
                        || ("2".equals(quality) && CollUtil.contains(type, 1))
                        || ("1".equals(quality) && CollUtil.contains(type, 1))) {
                    evidenceLevel = "III a";
                    recommendLevel = "B";
                    level.put(5, "III a" + ";" + "B");
                    continue;
                }

                // 质量低的 观察行研究 ｜｜ 质量低的病例报告
                if (("0".equals(quality) && CollUtil.contains(type, 5))
                        || ("0".equals(quality) && CollUtil.contains(type, 1))) {
                    evidenceLevel = "IV";
                    recommendLevel = "C";
                    level.put(6, "IV" + ";" + "C");
                    continue;
                }

                // 基础研究
                if (CollUtil.contains(type, 9)) {
                    evidenceLevel = "V";
                    recommendLevel = "D";
                    level.put(7, "V" + ";" + "D");
                }
            }
        }

        if (MapUtil.isNotEmpty(level)) {
            List<Map.Entry<Integer, String>> levelSort = level.entrySet().stream().sorted(Map.Entry.comparingByKey()).collect(Collectors.toList());
            Map.Entry<Integer, String> entry = levelSort.get(0);
            String value = entry.getValue();
            String[] split = value.split(";");
            recommendLevel = split[1];
            evidenceLevel = split[0];
        }
        result.put("recommendLevel", recommendLevel);
        result.put("evidenceLevel", evidenceLevel);
        return result;
    }

    /**
     * 根据药品和疾病获取指南中重要的信息数据
     * @param pdfTxt 指南原文
     * @param drugNames 药品名称及其同义词
     * @param diseases 疾病名称及其同义词
     * @return 获取到的指南的关键性信息
     */
    private List<String> getMainGuideInfo(String pdfTxt, List<String> drugNames, List<String> diseases){
        Set<String> resultSet = new HashSet<>();
        List<String> realDrugs = new ArrayList<>();
        List<String> realDiseases = new ArrayList<>();

        drugNames.forEach(drug -> {
            if (StringUtils.isNotBlank(drug)) {
                Pattern pattern = Pattern.compile(Pattern.quote(drug));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    realDrugs.add(group);
                }
            }
        });

        diseases.forEach(disease -> {
            if (StringUtils.isNotBlank(disease)) {
                Pattern pattern = Pattern.compile(Pattern.quote(disease));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    if (StrUtil.isNotBlank(group)) {
                        realDiseases.add(group);
                    }
                }
            }
        });

        String innerTxt = pdfTxt;
        String drugInnerTxt = pdfTxt;
        for (String realDrug : realDrugs) {
            int indexOf1 = innerTxt.indexOf(realDrug);

            for (String realDisease : realDiseases) {
                int indexOf2 = innerTxt.indexOf(realDisease);
                if (indexOf2 == -1){
                    continue;
                }
                int maxIndex = Math.max(indexOf1, indexOf2);
                int minIndex = Math.min(indexOf1, indexOf2);
                int abs = maxIndex - minIndex;
                //System.out.printf("indexOf1={%s}，indexOf2={%s}，abs={%s}", indexOf1, indexOf2, abs);
                //System.out.println();
                if (abs > 80) {
                    //将indexOf2破坏掉
                    String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                    String innerTxt2 = innerTxt.substring(0, indexOf2);
                    innerTxt = innerTxt2 + "@" + innerTxt1;
                    continue;
                }
                if (minIndex > 80) {
                    minIndex = minIndex - 80;
                }
                if (maxIndex + 80 < innerTxt.length()) {
                    maxIndex = maxIndex + 80;
                }
                //将原有结构破坏掉
                String txt;
                try {
                    txt = pdfTxt.substring(minIndex, maxIndex);
                } catch (Exception e) {
                    continue;
                }
                resultSet.add(txt);
                String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                String innerTxt2 = innerTxt.substring(0, indexOf2);
                innerTxt = innerTxt2 + "@" + innerTxt1;
            }
            //System.out.println("----------------------------------------------");
            //药品检索结束后破坏药品名称 将indexOf1破坏掉
            if (indexOf1 == -1){
                continue;
            }
            String innerTxt1 = drugInnerTxt.substring(indexOf1 + 1);
            String innerTxt2 = drugInnerTxt.substring(0, indexOf1);
            drugInnerTxt = innerTxt2 + "@" + innerTxt1;
            innerTxt = drugInnerTxt;
        }
        return new ArrayList<>(resultSet);
    }

    /**
     * 一、背景：
     * @param condition 检索条件
     * @param adverseInfo 安全性分析数据
     * @return 背景信息json数据
     */
    private JSONObject background(Condition condition, JSONObject adverseInfo) {
        String path = "一、背景：";
        String info = getInfo(condition);
        String[] split = info.split("治疗");
        String drug = split[0];
        String disease = split[1];
        JSONObject result = new JSONObject();
        //1、XX（药品名称）临床研究概述c
        String msg1 = "请用文字的形式表述一下“"+drug+"”的临床研究概述。 在返回的结果中请务必有段落感（如增加一下换行，空格，标号等等）。";
        String answer1 = wenChat(msg1, 1);
        formatLogs(path, msg1, answer1);
        JSONObject json1 = new JSONObject();
        json1.put("num", 1);
        json1.put("title", "1、" + drug + "临床研究概述");
        json1.put("data", wiffOfContent(answer1, "\n\n", "\n"));
        result.put("one", json1);
        //2、XX（疾病名称）的治疗进展
        String msg2 = "请用文字的形式表述一下“"+disease+"”的治疗进展。 在返回的结果中请务必有段落感（如增加一下换行，空格，标号等等）。";
        String answer2 = wenChat(msg2, 1);
        formatLogs(path, msg2, answer2);
        JSONObject json2 = new JSONObject();
        json2.put("num", 2);
        json2.put("title", "2、" + disease + "的治疗进展");
        json2.put("data", wiffOfContent(answer2, "\n\n", "\n"));
        result.put("two", json2);
        //3、XX（药品名称）治疗XX（疾病名称）
        String msg3 = "请针对"+disease+"的临床特点，以及流行病学信息进行阐述，并针对"+info+"进行知识总结。 在返回的结果中请务必有段落感（如增加一下换行，空格，标号等等）。";
        String answer3 = wenChat(msg3, 1);
        formatLogs(path, msg3, answer3);
        JSONObject json3 = new JSONObject();
        json3.put("num", 3);
        json3.put("title", "3、" + info);
        json3.put("data", wiffOfContent(answer3, "\n\n", "\n"));
        result.put("three", json3);
        //4、待评价药品介绍
        JSONObject json4 = new JSONObject();
        json4.put("num", 4);
        json4.put("title", "4、待评价药品介绍");
        JSONArray inner = new JSONArray();
        JSONArray infoForAdverse = adverseInfo.getJSONArray("instruction");
        for (int i = 0; i < infoForAdverse.size(); i++) {
            JSONObject jsonObject = infoForAdverse.getJSONObject(i);
            JSONObject innerJson = new JSONObject();
            innerJson.put("indications", HtmlUtil.cleanHtmlTag(jsonObject.getString("indications")));
            innerJson.put("usageAndDosage", HtmlUtil.cleanHtmlTag(jsonObject.getString("usageAndDosage")));
            innerJson.put("name", (i + 1) + "、" + jsonObject.getString("name"));
            inner.add(innerJson);
        }
        json4.put("data", inner);
        result.put("four", json4);
        return result;
    }

    /**
     * 二、有效性循证结果：
     * @param condition 检索条件
     * @param mongoLiteratures 纳入文献的集合
     * @return 有效性循证结果json数据
     */
    private JSONObject effective(Condition condition, List<MongoLiterature> mongoLiteratures) {
        String path = "二、有效性循证结果：";
        JSONObject effective = new JSONObject();
        String info = getInfo(condition);
        String[] split = info.split("治疗");
        String drugInfo = split[0];
        String diseaseInfo = split[1];
        //1、说明书查询结果：
        String msg1 = "请基于"+diseaseInfo+"的治疗现状以及"+drugInfo+"的说明书以及相关的文献、临床指南，判断一下"+info+"是否属于超说明书用药范畴？ 在返回的结果中请务必有段落感（如增加一下换行，空格，标号等等）。";
        String answer1 = wenChat(msg1, 1);
        formatLogs(path, msg1, answer1);
        JSONObject json1 = new JSONObject();
        json1.put("title", "1、说明书查询结果：");
        json1.put("data", wiffOfContent(answer1, "\n\n", "\n"));
        json1.put("num", 1);
        effective.put("one", json1);
        //2、指南/共识循证结果：
        List<String> drugs = new ArrayList<>();
        List<String> diseases = new ArrayList<>();
        List<Drug> drugList = condition.getDrugs();
        for (Drug drug : drugList) {
            String word = drug.getWord();
            drugs.add(word);
            String enWord = drug.getEnWord();
            if (StringUtils.isNotBlank(enWord)) {
                drugs.add(enWord);
            }
            List<WordStatus> enSynonym = drug.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)) {
                for (WordStatus wordStatus : enSynonym) {
                    if (wordStatus.getChecked()) {
                        drugs.add(wordStatus.getName());
                    }
                }
            }
            String zhWord = drug.getZhWord();
            if (StringUtils.isNotBlank(zhWord)) {
                drugs.add(zhWord);
            }
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)) {
                for (WordStatus wordStatus : zhSynonym) {
                    if (wordStatus.getChecked()) {
                        drugs.add(wordStatus.getName());
                    }
                }
            }
            List<WordStatus> otherSynonym = drug.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)) {
                for (WordStatus wordStatus : otherSynonym) {
                    if (wordStatus.getChecked()) {
                        drugs.add(wordStatus.getName());
                    }
                }
            }
            String expandSynonym = drug.getExpandSynonym();
            if (StringUtils.isNotBlank(expandSynonym)) {
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] expandSynonymSplit = expandSynonym.split(";");
                for (String txt : expandSynonymSplit) {
                    if (StringUtils.isNotBlank(txt)) {
                        drugs.add(txt.toLowerCase());
                    }
                }
            }
        }
        List<Disease> diseaseList = condition.getDiseases();
        for (Disease disease : diseaseList) {
            String word = disease.getWord();
            diseases.add(word);
            String enWord = disease.getEnWord();
            if (StringUtils.isNotBlank(enWord)) {
                diseases.add(enWord);
            }
            List<WordStatus> enSynonym = disease.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)) {
                for (WordStatus wordStatus : enSynonym) {
                    if (wordStatus.getChecked()) {
                        diseases.add(wordStatus.getName());
                    }
                }
            }
            String zhWord = disease.getZhWord();
            if (StringUtils.isNotBlank(zhWord)) {
                diseases.add(zhWord);
            }
            List<WordStatus> zhSynonym = disease.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)) {
                for (WordStatus wordStatus : zhSynonym) {
                    if (wordStatus.getChecked()) {
                        diseases.add(wordStatus.getName());
                    }
                }
            }
            String expandSynonym = disease.getExpandSynonym();
            if (StringUtils.isNotBlank(expandSynonym)) {
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] expandSynonymSplit = expandSynonym.split(";");
                for (String txt : expandSynonymSplit) {
                    if (StringUtils.isNotBlank(txt)) {
                        diseases.add(txt.toLowerCase());
                    }
                }
            }
        }
        JSONArray guideInfo = new JSONArray();
        List<String> titleList = new ArrayList<>();
        int guideNum = 0;
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(condition.getId()).and("status").is(1)), GuideIncludeOrExclude.class);
        for (GuideIncludeOrExclude guideIncludeOrExclude : guideIncludeOrExcludes) {
            GuideIndex content = elasticsearchRestTemplate.get(guideIncludeOrExclude.getGuideId(), GuideIndex.class);
            if (content != null) {
                String pdfTxt = content.getPdf_txt();
                List<String> mainGuideInfo = getMainGuideInfo(pdfTxt, drugs, diseases);
                if (CollUtil.isNotEmpty(mainGuideInfo)) {
                    if (guideNum >= 5) {
//                        titleList.add(content.getTitle() + (StringUtils.isNotBlank(content.getFbdate()) ? "-" + content.getFbdate() : "") + (StringUtils.isNotBlank(content.getZdz()) ? "-" + content.getZdz().replaceAll("\n", " ") : ""));
                        continue;
                    }
                    JSONObject inner = new JSONObject();
                    String title = content.getTitle();
                    String zdz = content.getZdz();
                    String fbdate = content.getFbdate();
                    inner.put("title", title + (StringUtils.isNotBlank(fbdate) ? "-" + fbdate : "") + (StringUtils.isNotBlank(zdz) ? "-" + zdz.replaceAll("\n", " ") : ""));
                    StringBuilder builder = new StringBuilder();
                    for (String s : mainGuideInfo) {
                        builder.append(s);
                    }
                    builder.insert(0, "请根据以下指南内容，汇总后生成一段话（与有效性相关）作为有效性总结，字数限制在200字左右。指南内容为：");
                    String answer2 = wenChat(builder.toString(), 1);
                    formatLogs(path, builder.toString(), answer2);
                    inner.put("data", answer2);
                    guideInfo.add(inner);
                    guideNum++;
                } else {
                    titleList.add(content.getTitle() + (StringUtils.isNotBlank(content.getFbdate()) ? "-" + content.getFbdate() : "") + (StringUtils.isNotBlank(content.getZdz()) ? "-" + content.getZdz().replaceAll("\n", " ") : ""));
                }
            }
        }

        for (String s : titleList) {
            JSONObject inner = new JSONObject();
            inner.put("title", s);
            inner.put("data", "");
            guideInfo.add(inner);
        }
        JSONObject json2 = new JSONObject();
        json2.put("title", "2、指南/共识循证结果：");
        json2.put("data", guideInfo);
        json2.put("num", 2);
        effective.put("two", json2);
        //3、文献资料循证结果：
//        StringBuilder paperBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(mongoLiteratures)) {
            if (mongoLiteratures.size() > 20) {
                mongoLiteratures = mongoLiteratures.subList(0, 20);
            }
//            for (MongoLiterature mongoLiterature : mongoLiteratures) {
//                paperBuilder.append(mongoLiterature.getTitle()).append("-");
//                paperBuilder.append(mongoLiterature.getSummary()).append("、");
//            }
        }
        // 2023 03 21 修改
        JSONArray literature = new JSONArray();
        for (int i = 0; i < mongoLiteratures.size(); i++) {
            MongoLiterature mongoLiterature = mongoLiteratures.get(i);
            StringBuilder stringBuilder = new StringBuilder();
            stringBuilder.append("（").append(i+1).append("）");
            String year = mongoLiterature.getYear();
            if (StrUtil.isNumeric(year)) {
                stringBuilder.append(year).append("年，");
            }            

            List<String> author = mongoLiterature.getAuthor();
            if (CollUtil.isNotEmpty(author)) {
                stringBuilder.append(String.join("，", author));
                String title = mongoLiterature.getTitle();
                if (StrUtil.isNotBlank(title)) {
                    stringBuilder.append(" 发布的 ").append(title);
                }
            } else {
                String title = mongoLiterature.getTitle();
                if (StrUtil.isNotBlank(title)) {
                    stringBuilder.append(title);
                }
            }
            
            String tldr = mongoLiterature.getTldr();
            String conclusion = mongoLiterature.getConclusion();
            if (StrUtil.isNotBlank(tldr)) {
                stringBuilder.append("：").append(tldr);
            } else {
                if (StrUtil.isNotBlank(conclusion)) {
                    stringBuilder.append("：").append(conclusion);
                }
            }
            literature.add(stringBuilder.toString());
        }
        
        JSONObject json3 = new JSONObject();
        json3.put("title", "3、文献资料循证结果：");
        json3.put("data", literature);
        json3.put("num", 3);
        effective.put("three", json3);
        return effective;
    }

    /**
     * 三、安全性循证结果：
     * @param condition 检索条件
     * @param adverseInfo 安全性分析数据
     * @return 安全性循证结果
     */
    private JSONObject safety(Condition condition, JSONObject adverseInfo) {
        String info = getInfo(condition);
        String[] split = info.split("治疗");
        String drugInfo = split[0];
        String path = "三、安全性循证结果：";
        JSONObject result = new JSONObject();
        //1、说明书中安全性相关信息：
        JSONArray instructionArr = new JSONArray();
        JSONArray infoForAdverse = adverseInfo.getJSONArray("instruction");
        for (int i = 0; i < infoForAdverse.size(); i++) {
            JSONObject jsonObject = infoForAdverse.getJSONObject(i);
            JSONObject innerJson = new JSONObject();
            //（1）禁忌：
            innerJson.put("taboo", jsonObject.getString("taboo"));
            JSONObject special = jsonObject.getJSONObject("special");
            //（2）孕妇及哺乳期妇女：
            innerJson.put("women", special.getString("women"));
            //（3）儿童用药：
            innerJson.put("children", special.getString("children"));
            //（4）老年用药：
            innerJson.put("old", special.getString("old"));
            //（5）肝肾功能不全
            innerJson.put("liverFunction", "");
            String usageAndDosage = jsonObject.getString("usageAndDosage");
            String notes = jsonObject.getString("notes");
            if (StringUtils.isNotBlank(usageAndDosage) || StringUtils.isNotBlank(notes)) {
                String msg1 = "“" + usageAndDosage + notes + "”" + "请帮忙提取以上内容中所有关于肾功能不全/肾功能损害或肝功能不全/肝功能损害相关的原文段落，请注意不要总结，输出原文字段即可，不要其他原文外的多余文字，如不要输出“以下是关于肾功能不全/肾功能损害或肝功能不全/肝功能损害相关的原文段落：”。";
                String answer1 = wenChat(msg1, 1);
                innerJson.put("liverFunction", answer1);
                formatLogs(path, msg1, answer1);
            }
            //（6）注意事项：
            innerJson.put("notes", jsonObject.getString("notes"));
            //（7）不良反应
            innerJson.put("adverse", jsonObject.getString("adverse"));
            innerJson.put("name", jsonObject.getString("name"));
            instructionArr.add(innerJson);
        }
        result.put("one", instructionArr);
        //2、政策分析：
        JSONArray policyArr = new JSONArray();
        JSONObject policy = adverseInfo.getJSONObject("policy");
        JSONArray newsFlash = policy.getJSONArray("newsFlash");
        if (!newsFlash.isEmpty()) {
            policyArr.addAll(newsFlash);
        }
        JSONArray report = policy.getJSONArray("report");
        if (!report.isEmpty()) {
            policyArr.addAll(report);
        }
        if (policyArr.isEmpty()) {
            JSONObject inner = new JSONObject();
            inner.put("title", "药监局暂未公布"+drugInfo+"相关的安全性信息。");
            inner.put("time", "");
            inner.put("content", new JSONArray());
            inner.put("originalContent", "");
            policyArr.add(inner);
        }
        result.put("two", policyArr);
        //3、FAERS数据库分析：
        JSONObject adverse = adverseInfo.getJSONObject("adverse");
        JSONObject adverseJson = new JSONObject();
        //统计不良反应数据
        JSONArray adverseJSONArray = adverse.getJSONArray("adverse");
        StringBuilder builder1 = new StringBuilder();
        if (CollUtil.isNotEmpty(adverseJSONArray)) {
            for (int i = 0; i < adverseJSONArray.size() - 1; i++) {
                JSONArray jsonArray = adverseJSONArray.getJSONArray(i);
                String name = jsonArray.getString(4);
                String percentage = jsonArray.getString(3);
                builder1.append(name).append("（").append(percentage).append("）").append("、");
            }
            JSONArray jsonArray = adverseJSONArray.getJSONArray(adverseJSONArray.size() - 1);
            if (CollUtil.isNotEmpty(jsonArray)) {
                String name = jsonArray.getString(4);
                String percentage = jsonArray.getString(3);
                builder1.append(name).append("（").append(percentage).append("）").append("等。");
            }
        }
        if (StringUtils.isNotBlank(builder1.toString())) {
            builder1.insert(0, "查询FAERS数据库中，"+info+"的常见不良反应为：");
        } else {
            builder1.append("FAERS数据库中暂未收录").append(info).append("相关的不良反应数据。");
        }
        adverseJson.put("adverse", builder1.toString());
        //统计典型信号数据
        JSONObject calculateTypicalSignals = adverse.getJSONObject("calculateTypicalSignals");
        Boolean outcome = calculateTypicalSignals.getBoolean("outcome");
        StringBuilder builder2 = new StringBuilder();
        if (!outcome) {
            JSONArray data = calculateTypicalSignals.getJSONArray("data");
            if (CollUtil.isNotEmpty(data)) {
                int num = data.size();
                if (num > 10) {
                    num = 10;
                }
                for (int i = 0; i < num - 1; i++) {
                    JSONObject jsonObject = data.getJSONObject(i);
                    String zh = jsonObject.getString("zh");
                    if (StringUtils.isNotBlank(zh)) {
                        builder2.append(zh).append("、");
                    }
                }
                JSONObject jsonObject = data.getJSONObject(num - 1);
                if (!jsonObject.isEmpty()) {
                    String zh = jsonObject.getString("zh");
                    if (StringUtils.isNotBlank(zh)) {
                        builder2.append(zh).append("等。");
                    }
                }
            }
        }
        if (StringUtils.isNotBlank(builder2.toString())) {
            builder2.insert(0, "上报数据中典型信号为：");
        }
        adverseJson.put("calculateTypicalSignals", builder2.toString());
        result.put("three", adverseJson);
        //4、ClinicalTrials严重不良反应分析：
        result.put("four", new JSONObject().put("data", ""));
        return result;
    }

    /**
     * 四、参考文献：
     * @param mongoLiteratures 纳入文献的集合
     * @return 集合格式的参考文献数据
     */
    private JSONArray references(List<MongoLiterature> mongoLiteratures) {
        JSONArray result = new JSONArray();
        if (CollUtil.isNotEmpty(mongoLiteratures)) {
            int num = 1;
            for (MongoLiterature mongoLiterature : mongoLiteratures) {
                StringBuilder builder = new StringBuilder();
                builder.append("[").append(num).append("]").append(" ");
                List<String> author = mongoLiterature.getAuthor();
                if (CollUtil.isNotEmpty(author)) {
                    if (author.size() > 2) {
                        author = author.subList(0, 3);
                    }
                    for (int i = 0; i < author.size() - 1; i++) {
                        builder.append(author.get(i)).append(",");
                    }
                    builder.append(author.get(author.size() - 1)).append(".");
                }
                String title = HtmlUtil.cleanHtmlTag(mongoLiterature.getTitle());
                builder.append(title).append(".");
                String year = mongoLiterature.getYear();
                if (StringUtils.isNotBlank(year)) {
                    builder.append(year).append(".");
                }
                num++;
                result.add(builder.toString());
            }
        }
        return result;
    }

    /**
     * 设置标题字体
     * @param value 标题内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setFirstTitle(String value, Document document, Font font) throws DocumentException {
        //Font font = new Font(null, 14, Font.BOLD);
        Paragraph title = new Paragraph(value);
        // 设置标题格式对齐方式
        title.setAlignment(Element.ALIGN_CENTER);
        title.setFont(font);
        title.setSpacingBefore(15f);
        title.setSpacingBefore(15f);
        document.add(title);
    }

    /**
     * 设置标题字体
     * @param value 标题内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setTitle(String value, Document document) throws DocumentException {
        Font font = new Font(null, 14, Font.BOLD);
        Paragraph title = new Paragraph(value);
        // 设置标题格式对齐方式
        title.setAlignment(Element.ALIGN_LEFT);
        title.setFont(font);
        title.setSpacingBefore(15f);
        title.setSpacingBefore(15f);
        document.add(title);
    }

    /**
     * 设置标题字体
     * @param value 标题内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setNormalTitle(String value, Document document) throws DocumentException {
        Font font = new Font(null, 14, Font.NORMAL);
        Paragraph title = new Paragraph(value);
        // 设置标题格式对齐方式
        title.setAlignment(Element.ALIGN_LEFT);
        title.setFont(font);
        title.setSpacingBefore(15f);
        title.setSpacingBefore(15f);
        document.add(title);
    }

    /**
     * 设置文本字体
     * @param value 文本内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setContent(String value, Document document) throws DocumentException {
        Font font = new Font(null, 14, Font.NORMAL);
        //去除换行符
        value = value.replaceAll("\n", "");
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        content.setFirstLineIndent(30);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_LEFT);
        content.setFont(font);
        content.setSpacingBefore(15f);
        content.setSpacingBefore(15f);
        document.add(content);
    }

    /**
     * 设置页码
     * @param document 文档
     */
    private void setPageNum(Document document) {
        Font font = new Font();
        Paragraph paraFooter = new Paragraph();
        //页脚的字体大小
        font.setSize(12f);
        font.setColor(new Color(0, 0, 0));
        paraFooter.add(new RtfPageNumber());
        paraFooter.add(" / ");
        paraFooter.add(new RtfTotalPageNumber());
        paraFooter.setFont(font);
        RtfHeaderFooter footer = new RtfHeaderFooter(paraFooter);
        //页脚的对齐方式（应该在footer设置而不是段落中设置）
        footer.setAlignment(1);
        document.setFooter(footer);
    }

    /**
     *
     * @param content 原文
     * @param oldChar 被替换的内容
     * @param newChar 需要替换的内容
     */
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) return "";
        if (content.contains(oldChar)) return content.replaceAll(oldChar, newChar);
        return content;
    }
}
