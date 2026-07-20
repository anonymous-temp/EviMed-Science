package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.Retryer;
import com.sentum.constants.CommonConstants;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.PromptEnum;
import com.sentum.enums.TraditionalPromptEnum;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.FormulaFeign;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.DrugContent;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.MongoLiterature;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.TraditionalGptService;
import com.sentum.util.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;



@Service
@Slf4j
public class TraditionalGptServiceImpl implements TraditionalGptService {


    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private RedisTemplate redisTemplate;

    @Autowired
    private FineScreenFeign fineScreenFeign;

    @Autowired
    private MedicineFeign medicineFeign;

    @Autowired
    private LxGptServiceImpl lxGptService;

    @Autowired
    private FormulaFeign formulaFeign;

    @Autowired
    private GptUtil gptUtil;



    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;


    @Override
    public void setAdvGpt(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult) {

    }


    private void addProcess(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        msg = formatInfo(msg);
        log.info(msg);
        stringBuilder.add(msg);
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }

    private void addProcessx(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(msg);
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }

    public static boolean isDouble(String str) {
        if (StringUtils.isEmpty(str)) {
            return false;
        }

        try {
            Double.parseDouble(str);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private double setScoreAndJson(Map<String, String> map, TraditionalPromptEnum promptEnum, double score, String content, JSONObject jsonObject) {
        String s2 = map.get(promptEnum.getKey());
        BulletinVo bulletinVo2 = new BulletinVo();
        //打分
        if (isDouble(s2)) {
            double score1 = Double.parseDouble(s2);
            bulletinVo2.setScore(Double.parseDouble(s2));
            score = score + score1;
        } else {
            bulletinVo2.setStringScore("0");
        }

        //药物组成
        if (TraditionalPromptEnum.DRUG_COMPOSITION.getKey().equals(promptEnum.getKey())&& StringUtils.isNotEmpty(content)){
            String[] split = content.split("、");
            if (split.length <= 18){
                score++;
                String score1 = bulletinVo2.getScore();
                bulletinVo2.setStringScore(Integer.parseInt(score1)+1+"");
            }

            if (content.contains("辅料")){
                score++;
                String score1 = bulletinVo2.getScore();
                bulletinVo2.setStringScore(Integer.parseInt(score1)+1+"");
            }
        }

        bulletinVo2.setContent(content);
        jsonObject.put(promptEnum.getKey(), bulletinVo2);
        return score;
    }

    private double setScoreAndJson(Map<String, String> map, TraditionalPromptEnum promptEnum, double score, String content, JSONObject jsonObject,String x) {
        String s2 = x;
        BulletinVo bulletinVo2 = new BulletinVo();
        //打分
        if (isDouble(s2)) {
            double score1 = Double.parseDouble(s2);
            bulletinVo2.setScore(Double.parseDouble(s2));
            score = score + score1;
        } else {
            bulletinVo2.setStringScore("0");
        }
        bulletinVo2.setContent(content);
        jsonObject.put(promptEnum.getKey(), bulletinVo2);
        return score;
    }

    @Override
    public int setEffective(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        JSONObject jsonObject = new JSONObject();
        double score = 0.0;
        futureResult.forEach((s, future) -> {
            try {
                if (s.equals("total1")) {
                    future.get();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        });

        String adverseReaction = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getAdverseReaction())) {
            adverseReaction = traditionalInfoDto.getAdverseReaction();
        } else {
            adverseReaction = "暂无内容";
        }
        score = setScoreAndJson(map, TraditionalPromptEnum.ADVERSEREACTION_RATING, score, adverseReaction, jsonObject);
        addProcess(id, step++, adverseReaction, stringBuilder);


        double specialScore = 0.0;

        addProcess(id, step++, "<b>1.2 特殊人群用药限制</b>", stringBuilder);
        addProcess(id, step++, "<b>1.2.1 儿童用药</b>", stringBuilder);
        String children = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getChildrenMedicine())) {
            children = traditionalInfoDto.getChildrenMedicine();
        } else {
            children = "暂无内容";
        }


        addProcess(id, step++, children, stringBuilder);
        specialScore = setScoreAndJson(map, TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN, specialScore, children, jsonObject);


        addProcess(id, step++, "<b>1.2.2 老人用药</b>", stringBuilder);
        String geriatric = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getGeriatricMedicine())) {
            geriatric = traditionalInfoDto.getGeriatricMedicine();
        } else {
            geriatric = "暂无内容";
        }
        addProcess(id, step++, geriatric, stringBuilder);
        specialScore = setScoreAndJson(map, TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC, specialScore, geriatric, jsonObject);


        addProcess(id, step++, "<b>1.2.3 孕妇及哺乳期妇女用药</b>", stringBuilder);
        String pregnantWomen = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getPregnantWomen())) {
            pregnantWomen = traditionalInfoDto.getPregnantWomen();
        } else {
            pregnantWomen = "暂无内容";
        }
        addProcess(id, step++, pregnantWomen, stringBuilder);
        specialScore = setScoreAndJson(map, TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN, specialScore, pregnantWomen, jsonObject);


        addProcess(id, step++, "<b>1.2.4 肝功能异常者</b>", stringBuilder);
        String liver = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithLiverDysfunction())) {
            liver = traditionalInfoDto.getDoseAdjustmentPatientsWithLiverDysfunction();
        } else {
            liver = "暂无内容";
        }
        addProcess(id, step++, liver, stringBuilder);
        specialScore = setScoreAndJson(map, TraditionalPromptEnum.SPECIAL_CROWD_LIVER, specialScore, liver, jsonObject);


        addProcess(id, step++, "<b>1.2.5 肾功能异常者</b>", stringBuilder);
        String renal = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
            renal = traditionalInfoDto.getDoseAdjustmentPatientsWithRenalInsufficiency();
        } else {
            renal = "暂无内容";
        }
        addProcess(id, step++, renal, stringBuilder);
        specialScore = setScoreAndJson(map, TraditionalPromptEnum.SPECIAL_CROWD_RENKONG, specialScore, renal, jsonObject);

        score = score + specialScore;


        addProcess(id, step++, "<b>1.3 安全性评价</b>", stringBuilder);
        futureResult.forEach((s, future) -> {
            if (s.equals("total2")) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    throw new RuntimeException(e);
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });
        String safety = traditionalInfoDto.getSafety();
        addProcess(id, step++, safety, stringBuilder);
        score = setScoreAndJson(map, TraditionalPromptEnum.SAFETY_EVALUATION, score, safety, jsonObject);


        //后续还数据库
        double otherScore = 0.0;
        addProcess(id, step++, "<b>1.4 其他</b>", stringBuilder);
        addProcess(id, step++, "<b>1.4.1 OTC</b>", stringBuilder);
        if (StringUtils.isNotEmpty(drugInfoNew.getOtc())&&!"处方药".equals(drugInfoNew.getOtc())){
            addProcess(id, step++, "本药品为"+drugInfoNew.getOtc(), stringBuilder);
            BulletinVo bulletinVo = new BulletinVo();
            bulletinVo.setStringScore("1");
            bulletinVo.setContent("本药品为"+drugInfoNew.getOtc());
            jsonObject.put("OTC", bulletinVo);
            otherScore += 1;
        }else {
            addProcess(id, step++, "处方药", stringBuilder);
            BulletinVo bulletinVo = new BulletinVo();
            bulletinVo.setStringScore("0");
            bulletinVo.setContent("处方药");
            jsonObject.put("OTC", bulletinVo);
            otherScore += 0;
        }

     ;


        addProcess(id, step++, "<b>1.4.2 不良事件通报或特殊安全风险警示</b>", stringBuilder);


        boolean flag = false;
        boolean flag2 = false;
        //五级中文
        String drugZh = drugInfoNew.getDrugZh();
        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugZh);
        drugZhs.addAll(drugInfoNew.getDrugSynonymZh());
        drugZhs.remove("");
        log.info("药物警戒{}", drugZh);
        // Criteria criteria = Criteria.where("synopsis").regex(Pattern.compile(".*" + drugZh + ".*", Pattern.CASE_INSENSITIVE));
        // 创建查询对象
        List<Criteria> orCriteriaList = new ArrayList<>();
        for (String drug : drugZhs) {
            orCriteriaList.add(Criteria.where("synopsis").regex(Pattern.compile(".*" + drug + ".*", Pattern.CASE_INSENSITIVE)));
        }

        Criteria criteria = new Criteria().orOperator(orCriteriaList.toArray(new Criteria[0]));
        Query query = new Query(criteria);
        query.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
        List<JSONObject> pharmacovigilance = mongoTemplate.find(query, JSONObject.class, "pharmacovigilance");
        List<Criteria> orCriteriaList2 = new ArrayList<>();
        for (String drug : drugZhs) {
            orCriteriaList2.add(Criteria.where("title").regex(Pattern.compile(".*" + drug + ".*", Pattern.CASE_INSENSITIVE)));
        }
        Criteria criteria2 = new Criteria().orOperator(orCriteriaList2.toArray(new Criteria[0]));
        Query query2 = new Query(criteria2);
        query2.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
        List<JSONObject> pharmacovigilanceAdd = mongoTemplate.find(query2, JSONObject.class, "pharmacovigilance");
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        ArrayList<JSONObject> jsonObjects1 = new ArrayList<>();
        List<JSONObject> pharmacovigilanceAdd1 = new ArrayList<>();
        List<JSONObject> pharmacovigilanceAdd2 = new ArrayList<>();

        if (pharmacovigilanceAdd.size() > 0) {
            for (int i = 0; i < pharmacovigilanceAdd.size(); i++) {

                String string = pharmacovigilanceAdd.get(i).getString("title");
                if (string.contains("修订")) {
                    pharmacovigilanceAdd1.add(pharmacovigilanceAdd.get(i));
                } else {
                    pharmacovigilanceAdd2.add(pharmacovigilanceAdd.get(i));
                }
            }
        }
        if (pharmacovigilanceAdd2.size() > 0) {
            for (int i = 0; i < pharmacovigilanceAdd2.size(); i++) {
                String circleNumber = i + 1 + ")"; // 根据索引生成对应带圈数字的字符
                JSONObject jsonObject1 = new JSONObject();
                jsonObject1.put("title", circleNumber + pharmacovigilanceAdd2.get(i).getString("title") +
                        "(发布时间：" + pharmacovigilanceAdd2.get(i).getString("data_time") + ")");
                jsonObject1.put("url", pharmacovigilanceAdd2.get(i).getString("title_url"));
                jsonObjects1.add(jsonObject1);
                if (i == 0) {
                    addProcess(id, step++, circleNumber + pharmacovigilanceAdd2.get(i).getString("title") +
                            "(发布时间：" + pharmacovigilanceAdd2.get(i).getString("data_time") + ")...", stringBuilder);
                    jsonObject.put("adverseEventScore", 0);
                }
            }
        } else {
            flag2 = true;
            addProcess(id, step++, "在国家药品监督管理局（NMPA）、国家药品监督管理局药品评价中心、国家药品不良反应监测中心中，均未检索到与" + drugInfoNew.getDrugName() + "相关的不良事件通报信息。", stringBuilder);
        }

        if (pharmacovigilance.size() > 0) {
            if (pharmacovigilance.size() > 0) {
                for (int i = 0; i < pharmacovigilance.size(); i++) {
                    JSONObject jsonObject1 = new JSONObject();
                    String content = "";
                    JSONArray synopsis = pharmacovigilance.get(i).getJSONArray("synopsis");
                    for (String o : synopsis.toJavaList(String.class)) {
                        for (String s : drugZhs) {
                            if (o.contains(s)) {
                                content = o;
                            }
                        }
                    }
                    String circleNumber = (i + 1) + ")"; // 根据索引生成对应带圈数字的字符
                    jsonObject1.put("title", circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                            "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")");
                    jsonObject1.put("url", pharmacovigilance.get(i).getString("title_url"));
                    jsonObjects.add(jsonObject1);
                    if (i == 0) {
                        addProcess(id, step++, circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")...", stringBuilder);
                        jsonObject.put("adverseEventScore", 0);
                    }

                }
            }
        } else {
           flag = true;
            addProcess(id, step++, "在国家药品监督管理局（NMPA）、国家药品监督管理局药品评价中心、国家药品不良反应监测中心中，均未检索到与" + drugInfoNew.getDrugName() + "相关的特殊安全风险警示。", stringBuilder);
            jsonObject.put("adverseEventScore", 1);
        }





//        BulletinVo bulletinVo1 = new BulletinVo();
//        bulletinVo1.setScore(1.0);
//        bulletinVo1.setContent(jsonObjects);
        jsonObject.put("adverseEventContent", jsonObjects1);


        jsonObject.put("adverseEventAddContent", jsonObjects);
        if (flag && flag2){
            otherScore+=1;
            jsonObject.put("adverseEventScore", 1);
        }


        ArrayList<JSONObject> jsonObjects2 = new ArrayList<>();
        addProcess(id, step++, "<b>1.4.3. 说明书修订</b>", stringBuilder);
        if (pharmacovigilanceAdd1.size() > 0) {
            for (int i = 0; i < pharmacovigilanceAdd1.size(); i++) {
                String circleNumber = (i + 1) + ")"; // 根据索引生成对应带圈数字的字符
                JSONObject jsonObject1 = new JSONObject();
                jsonObject1.put("title", circleNumber + pharmacovigilanceAdd1.get(i).getString("title") +
                        "(发布时间：" + pharmacovigilanceAdd1.get(i).getString("data_time") + ")");
                jsonObject1.put("url", pharmacovigilanceAdd1.get(i).getString("title_url"));
                jsonObjects2.add(jsonObject1);
                if (i == 0) {
                    addProcess(id, step++, circleNumber + pharmacovigilanceAdd1.get(i).getString("title") +
                            "(发布时间：" + pharmacovigilanceAdd1.get(i).getString("data_time") + ")...", stringBuilder);
                    jsonObject.put("reviseScore", 0);
                }
            }
        } else {
            otherScore += 1;
            jsonObject.put("reviseScore", 1);
            addProcess(id, step++, "在国家药品监督管理局（NMPA）、国家药品监督管理局药品评价中心、国家药品不良反应监测中心中，均未检索到" + drugInfoNew.getDrugName() + "修改说明书相关的通知公告。", stringBuilder);
        }
        jsonObject.put("reviseContent", jsonObjects2);


        score = score + otherScore;
        jsonObject.put("otherScore", removeTrailingZerosFromDouble(otherScore));
        jsonObject.put("specialScore", removeTrailingZerosFromDouble(specialScore));
        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在安全性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        bulletinBoardVo.setSecurity(jsonObject);
        return step;


    }

    private String removeTrailingZerosFromDouble(Double value) {
        if (value == (long) value.doubleValue()) {
            return Long.toString(value.longValue());
        } else {
            return value.toString();
        }
    }

    @Override
    public int setEffective1(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        JSONObject jsonObject = new JSONObject();
        double score = 10;

        ArrayList<GuidelinesVo> guidelinesVo1s = new ArrayList<>();
        ArrayList<GuidelinesVo> guidelinesVo2s = new ArrayList<>();
        if (CollUtil.isNotEmpty(traditionalInfoDto.getGuide())) {
            for (GuidelinesVo guidelinesVo : traditionalInfoDto.getGuide()) {
                if ((guidelinesVo.getShowField().contains("诊疗规范")
                        || guidelinesVo.getShowField().contains("指导原则")|| guidelinesVo.getShowField().contains("卫健委")|| guidelinesVo.getShowField().contains("卫生部")|| guidelinesVo.getShowField().contains("卫生健康委员会"))&&
                !guidelinesVo.getShowField().contains("共识")) {
                    guidelinesVo1s.add(guidelinesVo);
                } else {
                    guidelinesVo2s.add(guidelinesVo);
                }
            }
        }
        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        if (CollUtil.isNotEmpty(traditionalInfoDto.getGuide())) {
            addProcess(id, step++, "<b>2.1 评价指南</b>", stringBuilder);
           if (CollUtil.isNotEmpty(guidelinesVo1s)){
               for (GuidelinesVo guidelinesVo : guidelinesVo1s) {
                   addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);
               }
           }else {
               for (GuidelinesVo guidelinesVo : guidelinesVo2s) {
                   addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);
               }
           }
        }

        if (CollUtil.isNotEmpty(traditionalInfoDto.getLiterature()) && CollUtil.isEmpty(traditionalInfoDto.getGuide())) {
            addProcess(id, step++, "<b>2.1 参考文献</b>", stringBuilder);

            for (GuidelinesVo guidelinesVo : traditionalInfoDto.getLiterature()) {
                addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);

            }
        }
        if (CollUtil.isNotEmpty(guidelinesVo1s)){

            score = 20;
        }else if (CollUtil.isNotEmpty(guidelinesVo2s)){
            for (GuidelinesVo guidelinesVo2 : guidelinesVo2s) {
                if (guidelinesVo2.getShowField().contains("共识")){
                    score = 16;
                }else {
                    score = 18;
                    break;
                }
            }

        }else if (CollUtil.isNotEmpty(traditionalInfoDto.getLiterature())){
            boolean x = false;
            for (GuidelinesVo literature : traditionalInfoDto.getLiterature()) {
                if (literature.getShowField().contains("(")){
                    x = true;
                }
            }
            if (x){
                score = 12;
            }
        }
        String classic = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getClassic())&&traditionalInfoDto.getClassic().contains("收录在了")){
            classic = traditionalInfoDto.getClassic();
            score = 20;
        }
        if (CollUtil.isEmpty(guidelinesVo1s)&&CollUtil.isEmpty(guidelinesVo2s)&&CollUtil.isEmpty(traditionalInfoDto.getLiterature())){
            score = 0;
            addProcess(id, step++, "暂未找到"+drugInfoNew.getDrugName()+"相关诊疗规范/《古代经典名方目录》/指南/共识/文献推荐。", stringBuilder);
        }

        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("standardsGuide", guidelinesVo1s);
        jsonObject.put("guide", guidelinesVo2s);
        jsonObject.put("literature", traditionalInfoDto.getLiterature());
        jsonObject.put("classicFormula", classic);
        bulletinBoardVo.setEffectiveness(jsonObject);
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在有效性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        return step;
    }

    @Override
    public int setEffective1App(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        JSONObject jsonObject = new JSONObject();
        double score = 10;
        futureResult.forEach((s, future) -> {
            if (s.equals("total2")) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    throw new RuntimeException(e);
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });

        ArrayList<GuidelinesVo> guidelinesVo1s = new ArrayList<>();
        ArrayList<GuidelinesVo> guidelinesVo2s = new ArrayList<>();
        if (CollUtil.isNotEmpty(traditionalInfoDto.getGuide())) {
            for (GuidelinesVo guidelinesVo : traditionalInfoDto.getGuide()) {
                if ((guidelinesVo.getShowField().contains("诊疗规范")
                        || guidelinesVo.getShowField().contains("指导原则")|| guidelinesVo.getShowField().contains("卫健委")|| guidelinesVo.getShowField().contains("卫生部")|| guidelinesVo.getShowField().contains("卫生健康委员会"))&&
                        !guidelinesVo.getShowField().contains("共识")) {
                    guidelinesVo1s.add(guidelinesVo);
                } else {
                    guidelinesVo2s.add(guidelinesVo);
                }
            }
        }
        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        if (CollUtil.isNotEmpty(traditionalInfoDto.getGuide())) {

            if (CollUtil.isNotEmpty(guidelinesVo1s)){
                for (GuidelinesVo guidelinesVo : guidelinesVo1s) {
                    addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);
                }
            }else {
                for (GuidelinesVo guidelinesVo : guidelinesVo2s) {
                    addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);
                }
            }
        }

        if (CollUtil.isNotEmpty(traditionalInfoDto.getLiterature()) && CollUtil.isEmpty(traditionalInfoDto.getGuide())) {


            for (GuidelinesVo guidelinesVo : traditionalInfoDto.getLiterature()) {
                addProcess(id, step++, guidelinesVo.getShowField(), stringBuilder);

            }
        }
        if (CollUtil.isNotEmpty(guidelinesVo1s)){

            score = 20;
        }else if (CollUtil.isNotEmpty(guidelinesVo2s)){
            for (GuidelinesVo guidelinesVo2 : guidelinesVo2s) {
                if (guidelinesVo2.getShowField().contains("共识")){
                    score = 16;
                }else {
                    score = 18;
                    break;
                }
            }

        }else if (CollUtil.isNotEmpty(traditionalInfoDto.getLiterature())){
            boolean x = false;
            for (GuidelinesVo literature : traditionalInfoDto.getLiterature()) {
                if (literature.getShowField().contains("(")){
                    x = true;
                }
            }
            if (x){
                score = 12;
            }
        }
        String classic = "";
        if (StringUtils.isNotEmpty(traditionalInfoDto.getClassic())&&traditionalInfoDto.getClassic().contains("收录在了")){
            classic = traditionalInfoDto.getClassic();
            score = 20;
        }

        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("standardsGuide", guidelinesVo1s);
        jsonObject.put("guide", guidelinesVo2s);
        jsonObject.put("literature", traditionalInfoDto.getLiterature());
        jsonObject.put("classicFormula", classic);
        bulletinBoardVo.setEffectiveness(jsonObject);
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在有效性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        return step;
    }



    @Override
    public int setMoneyRelevant(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        addProcess(id, step++, "<b>3、经济性</b>", stringBuilder);
        addProcess(id, step++, "考察待遴选药品与同通用名药物或同功能主治药品的日均治疗费用差异。", stringBuilder);
        BulletinVo bulletinVo = new BulletinVo();
        double score = 0;
        String money = "";
        if (StringUtils.isEmpty(traditionalInfoDto.getEconomyradion())){
            traditionalInfoDto.setEconomyradion("2");
        }
        switch (traditionalInfoDto.getEconomyradion()) {
            case "1":
                score = 15;
                money = "待遴选药品日均治疗费用最低，得15分。";
                break;

            case "2":
                score = 14;
                money = "待评价药品日均治疗费用低于中位数，得14分。";
                break;

            case "3":
                score = 13;
                money = "待评价药品日均治疗费用等于中位数，得13分。";
                break;

            case "4":
                score = 12;
                money = "待评价药品日均治疗费用高于中位数，得12分。";
                break;

            case "5":
                score = 11;
                money = "待评价药品日均治疗费用最高，得11分。";

        }

        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("score", removeTrailingZerosFromDouble(score));
        jsonObject1.put("content", money);
        jsonObject1.put("scoreDescribe", drugInfoNew.getDrugName() + "在经济性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        bulletinBoardVo.setEconomicViability(jsonObject1);
        addProcess(id, step++, money, stringBuilder);

        return step;


    }

    @Override
    public int setDrugCharacteristic(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        double score = 0;
        futureResult.forEach((s, future) -> {
            if (s.equals("total2")) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    throw new RuntimeException(e);
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });

        JSONObject jsonObject = new JSONObject();
        addProcess(id, step++, "<b>4、药学特性</b>", stringBuilder);
        addProcess(id, step++, "考察待遴选药品与同通用名及同功能主治药品的药学特性差异。", stringBuilder);
        addProcess(id, step++, "<b>4.1 药物组成</b>", stringBuilder);
        //获取药物成分
        String ingredient = traditionalInfoDto.getIngredient();
        if (StringUtils.isEmpty(ingredient)) {
            try {
                ingredient = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的药品成分是什么", "bing");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, ingredient, stringBuilder);
        score = setScoreAndJson(map, TraditionalPromptEnum.DRUG_COMPOSITION, score, ingredient, jsonObject);
        double modernResearchScore = 0.0;
        addProcess(id, step++, "<b>4.2 现代研究</b>", stringBuilder);
        addProcess(id, step++, "<b>4.2.1 药理作用</b>", stringBuilder);
        String pharmacologicalEffect = traditionalInfoDto.getPharmacology();
        if (StringUtils.isEmpty(pharmacologicalEffect)) {
            try {
                pharmacologicalEffect = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的药理作用", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, pharmacologicalEffect, stringBuilder);
        modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY, modernResearchScore, pharmacologicalEffect, jsonObject);

        addProcess(id, step++, "<b>4.2.2 指纹图谱研究</b>", stringBuilder);
        String fingerprint = traditionalInfoDto.getFingerprint();
        if (StringUtils.isEmpty(fingerprint)) {
            try {
                fingerprint = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的指纹图谱研究", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, fingerprint, stringBuilder);
        if (StringUtils.isNotEmpty(fingerprint)&&fingerprint.contains("《")){
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT, modernResearchScore, fingerprint, jsonObject,"1");
        }else {
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT, modernResearchScore, fingerprint, jsonObject);
        }


        addProcess(id, step++, "<b>4.2.3 有效性再评价</b>", stringBuilder);
        String reevaluation = traditionalInfoDto.getValidity();
        if (StringUtils.isEmpty(reevaluation)) {
            try {
                reevaluation = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的有效性再评价", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, reevaluation, stringBuilder);
        if (StringUtils.isNotEmpty(reevaluation)&&reevaluation.contains("《")){
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS, modernResearchScore, reevaluation, jsonObject,"1");
        }else {
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS, modernResearchScore, reevaluation, jsonObject);
        }


        addProcess(id, step++, "<b>4.2.4 含量测定法</b>", stringBuilder);
        String contentDeterminationMethod = traditionalInfoDto.getContent();
        if (StringUtils.isEmpty(contentDeterminationMethod)) {
            try {
                contentDeterminationMethod = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的含量测定法", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, contentDeterminationMethod, stringBuilder);
        if (StringUtils.isNotEmpty(contentDeterminationMethod)&&contentDeterminationMethod.contains("《")){
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION, modernResearchScore, contentDeterminationMethod, jsonObject,"1");

        }else {
            modernResearchScore = setScoreAndJson(map, TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION, modernResearchScore, contentDeterminationMethod, jsonObject);

        }

        score += modernResearchScore;


        addProcess(id, step++, "<b>4.3 贮存条件</b>", stringBuilder);
        String storageConditions = traditionalInfoDto.getStorage();
        if (StringUtils.isEmpty(storageConditions)) {
            try {
                storageConditions = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的贮存条件", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, storageConditions, stringBuilder);
        futureResult.forEach((s, future) -> {
            if (s.equals("storage")) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    throw new RuntimeException(e);
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });
        score = setScoreAndJson(map, TraditionalPromptEnum.STORAGE, score, storageConditions, jsonObject);

        futureResult.forEach((s, future) -> {
            if (s.equals("validity")) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    throw new RuntimeException(e);
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });
        addProcess(id, step++, "<b>4.4 药品有效期</b>", stringBuilder);
        String expiration = traditionalInfoDto.getIndate();
        if (StringUtils.isEmpty(expiration)) {
            try {
                expiration = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的药品有效期", "现代研究");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, expiration, stringBuilder);
        score = setScoreAndJson(map, TraditionalPromptEnum.VALIDITY, score, expiration, jsonObject);

        jsonObject.put("modernResearchScore", removeTrailingZerosFromDouble(modernResearchScore));
        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在药学特性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        bulletinBoardVo.setPharmacy(jsonObject);

        return step;
    }

    @Override
    public int setApplicability(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        double score = 0;
        futureResult.forEach(
                (s5, future) -> {
                    try {
                        future.get();
                    } catch (InterruptedException | ExecutionException e) {
                        throw new RuntimeException(e);
                    }
                }
        );

        JSONObject jsonObject = new JSONObject();
        addProcess(id, step++, "<b>5、适用性</b>", stringBuilder);
        addProcessx(id, step++, "考察待遴选药品与同通用名及同功能主治药品的临床适用性差异。", stringBuilder);
        addProcess(id, step++, "<b> 5.1 药物选择</b>", stringBuilder);
        String drugSelection = traditionalInfoDto.getDrugChoice();
        addProcess(id, step++, drugSelection, stringBuilder);
        score = setScoreAndJson(map, TraditionalPromptEnum.DRUG_CHOICE, score, drugSelection, jsonObject);

        double instructionScore = 0.0;
        addProcess(id, step++, "<b> 5.2 说明书信息评价</b> ", stringBuilder);
        addProcess(id, step++, "<b> 5.2.1 功能主治</b>", stringBuilder);
        String function = traditionalInfoDto.getIndications();
        if (StringUtils.isEmpty(function)) {
            try {
                function = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的说明书信息评价", "说明书信息评价");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, function, stringBuilder);
        instructionScore = setScoreAndJson(map, TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE, instructionScore, function, jsonObject);

        addProcess(id, step++, "<b> 5.2.2 性状</b>", stringBuilder);
        String appearance = traditionalInfoDto.getDescription();
        if (StringUtils.isEmpty(appearance)) {
            try {
                appearance = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "性状", "说明书信息评价");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        addProcess(id, step++, appearance, stringBuilder);
        instructionScore = setScoreAndJson(map, TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION, instructionScore, appearance, jsonObject);


        addProcess(id, step++, "<b> 5.2.3 说明书中是否有“尚不明确”等描述</b>", stringBuilder);
        String unclear = traditionalInfoDto.getContraindications();
        addProcess(id, step++, unclear, stringBuilder);
        BulletinVo bulletinVo = new BulletinVo();
        if (unclear != null&&(unclear.contains("尚不明确")||unclear.contains("未明确")||unclear.contains("未明确说明"))){
            bulletinVo.setStringScore("0");
        }else {
            bulletinVo.setStringScore("1");
            instructionScore += 1;
        }

        bulletinVo.setContent(unclear);
        jsonObject.put("unclear", bulletinVo);
        //todo 未找到
        addProcess(id, step++, "<b> 5.2.4 便利性与依从性</b>", stringBuilder);
        //剂型
        String dosageForm = drugInfoNew.getDosageForm();
        if (StringUtils.isNotEmpty(dosageForm)){
            dosageForm = dosageForm.replaceAll("\\n","");
            addProcess(id, step++, dosageForm, stringBuilder);
        }
        //用法用量
        String usageAndDosage = drugInfoNew.getUsageAndDosage();
        if (StringUtils.isNotEmpty(usageAndDosage)){
            usageAndDosage = usageAndDosage.replaceAll("\\n","");
            addProcess(id, step++, usageAndDosage, stringBuilder);
        }
        BulletinVo bulletinVo1 = new BulletinVo();
        bulletinVo1.setScore(2.0);
        bulletinVo1.setContent("本产品为：" + dosageForm + "\n" + usageAndDosage);
        instructionScore += 2;
        score += instructionScore;
        jsonObject.put("dependability", bulletinVo1);
        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在适用性上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        //说明书评价分数
        jsonObject.put("instructionScore", removeTrailingZerosFromDouble(instructionScore));
        bulletinBoardVo.setApplicability(jsonObject);


        return step;
    }

    private String formatInfo(String info) {
        if (ObjectUtil.isNotNull(info)) {
            int length = info.length();
            if (length > 90) {
                info = info.replaceAll("</br>", "");
                info = calculateScoreAndTruncate(info) + "...";
            }
        }
        return info;
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

    private boolean isEnglishOrDigit(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }

    private boolean isChineseCharacter(char c) {
        return c >= '\u4e00' && c <= '\u9fa5';
    }

    @Override
    public int setPolicyAdmission(DrugInfoNew drugInfoNew, Map<String, Future<Boolean>> futureResult, int step, String id, List<String> stringBuilder, Map<String, String> map, BulletinBoardVo bulletinBoardVo, TraditionalInfoDto traditionalInfoDto) {
        double score = 0;
        JSONObject jsonObject = new JSONObject();
        addProcess(id, step++, "<b>6、政策准入</b>", stringBuilder);
        addProcess(id, step++, "考察待遴选药品国家医保、国家基本药物目录的收录情况；《中国药典》收载情况；知识产权和企业信誉共5个方面的属性。", stringBuilder);
        addProcess(id, step++, "<b>6.1 国家基本药物目录收录情况</b>", stringBuilder);
        String essentialMedicines = drugInfoNew.getEssentialMedicines();
        boolean isBase = false;
        if ("是".equals(essentialMedicines)) {
            isBase = true;
        }
        String nationalMedicine = isBase ? "已被纳入国家基本药物目录" : "未纳入国家基本药物目录";
        addProcess(id, step++, nationalMedicine, stringBuilder);
        BulletinVo bulletinVo = new BulletinVo();
        if (isBase) {
            bulletinVo.setScore(5.0);
            score += 5;
        } else {
            bulletinVo.setScore(1.0);
            score += 1;
        }
        bulletinVo.setContent(nationalMedicine);
        jsonObject.put("basicMedicine", bulletinVo);


        addProcess(id, step++, "<b>6.2 国家医保目录收录情况</b>", stringBuilder);
        boolean isInsurance = false;
        String medicalInsurance = drugInfoNew.getMedicalInsurance();
        if (StringUtils.isNotBlank(medicalInsurance)) {
            isInsurance = true;
        }

        // 医保得分
        float isInsuranceScore = 1.00F;
        String pay = "";
        if (isInsurance) {
            boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfoNew.getPaymentScope());
            if ("甲".equals(medicalInsurance)) {
                if (paymentScopeStatus) {
                    isInsuranceScore = 4.00F;
                } else {
                    isInsuranceScore = 5.00F;
                }
            } else {
                if (paymentScopeStatus) {
                    isInsuranceScore = 2.00F;
                } else {
                    isInsuranceScore = 3.00F;
                }
            }
            pay = paymentScopeStatus?"，"+drugInfoNew.getPaymentScope():"，无支付限制";
        }
        addProcess(id, step++, isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfoNew.getMedicalInsurance()) ? "，" + drugInfoNew.getMedicalInsurance() : "")+pay : "未纳入医保"+pay, stringBuilder);

        BulletinVo bulletinVo1 = new BulletinVo();
        bulletinVo1.setScore(Double.valueOf(isInsuranceScore));
        bulletinVo1.setContent(isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfoNew.getMedicalInsurance()) ? "，" + drugInfoNew.getMedicalInsurance() : "")+pay : "未纳入医保"+pay);
        jsonObject.put("medicalInsurance", bulletinVo1);
        score += isInsuranceScore;

        addProcess(id, step++, "<b>6.3 《中国药典》收录情况</b>", stringBuilder);
        if (StringUtils.isNotEmpty(drugInfoNew.getIsInclude())&&"收载在《中国药典》中。".equals(drugInfoNew.getIsInclude())){
            String chineseMedicine = "本品已收录在《中国药典》中。";
            addProcess(id, step++, chineseMedicine, stringBuilder);
            BulletinVo bulletinVo2 = new BulletinVo();
            bulletinVo2.setStringScore("5");
            score+=5;
            bulletinVo2.setContent(chineseMedicine);
            jsonObject.put("chineseMedicine", bulletinVo2);
        }else {
            String chineseMedicine = "本品未收录在《中国药典》中。";
            addProcess(id, step++, chineseMedicine, stringBuilder);
            BulletinVo bulletinVo2 = new BulletinVo();
            bulletinVo2.setStringScore("1");
            score+=1;
            bulletinVo2.setContent(chineseMedicine);
            jsonObject.put("chineseMedicine", bulletinVo2);
        }

        double intellectualScore = 0.0;
        addProcess(id, step++, "<b>6.4 知识产权</b>", stringBuilder);
        addProcess(id, step++, "<b>6.4.1 国家保密品种或国家保护品种</b>", stringBuilder);
        String nationalSecrecy = drugInfoNew.getIngredient();
        String scorex = "0";
        String x = "";
        String x2 = lxGptService.getGpt("药品:" + drugInfoNew.getDrugName() + "\n成分:" + nationalSecrecy + "**********\n本药品是否含国家保密成分，返回是或否","","");
        if ("是".equals(x2)) {
            x = "本药品为国家保密品种，";
            scorex = "2";
        }else {
            x = "本药品非国家保密品种，";
        }
        if (StringUtils.isNotEmpty(drugInfoNew.getIsProtected())) {
           scorex = "2";
           x = x+"本药品为国家保护品种。";
        }else{
            x = x+"本药品非国家保护品种。";
        }

        intellectualScore += Double.valueOf(scorex);
        BulletinVo bulletinVo3 = new BulletinVo();
        bulletinVo3.setContent(x);
        bulletinVo3.setStringScore(scorex);
        jsonObject.put("nationalSecrecy", bulletinVo3);
        addProcess(id, step++, x, stringBuilder);

        addProcess(id, step++, "<b>6.4.2 专利、奖励或专项</b>", stringBuilder);
        String patent = "";
        try {
            patent = traditionalInfoDto.getPatent();
        } catch (Exception e) {
            e.printStackTrace();
        }
        addProcess(id, step++, patent, stringBuilder);
        intellectualScore = setScoreAndJson(map, TraditionalPromptEnum.PATENT, intellectualScore, patent, jsonObject);

        score += intellectualScore;

        addProcess(id, step++, "<b>6.5 企业状况</b>", stringBuilder);
        //企业生产情况
        String production = traditionalInfoDto.getManufacturers();
        addProcess(id, step++, production, stringBuilder);
        score = setScoreAndJson(map, TraditionalPromptEnum.MANUFACTURERS, score, production, jsonObject);
        jsonObject.put("score", removeTrailingZerosFromDouble(score));
        jsonObject.put("intellectualScore", removeTrailingZerosFromDouble(intellectualScore));
        jsonObject.put("scoreDescribe", drugInfoNew.getDrugName() + "在政策准入上的得分为：" + removeTrailingZerosFromDouble(score) + "分");
        bulletinBoardVo.setPolicy(jsonObject);


        return step;
    }


    private String youyideyi(String msg, JSONObject responseFormat, String model) {
        long ts = System.currentTimeMillis();
        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
        //["gpt-3.5-turbo","gpt-4-0613"]
//        jsonObject1.put("model", "gpt-4-0613");  // 112068
//        jsonObject1.put("model", "gpt-3.5-turbo");  // 慢  105605
        //      jsonObject1.put("model", "gpt-4");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-3.5-turbo-16k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-4-32k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out

        jsonObject1.put("model", model);
        jsonObject1.put("responseFormat", responseFormat);
        if (!ObjectUtil.isEmpty(responseFormat)) {
            System.out.println(jsonObject1.toString());
        }
        String response = null;
        try {
            Retryer retryer = GuavaRetryer.createRetryer();
            response = (String) retryer.call(() -> {
                return gptUtil.generation(jsonObject1);

            });

        } catch (Exception e) {
            log.error(e.getMessage() + "*********gpt调用失败*************prompt:" + msg, e);
        }
//        log.info(response.body());
        log.info("call gpt cost time:{}", System.currentTimeMillis() - ts);
        if (StringUtils.isNotEmpty(response)) {
            response = response.replaceAll("\\uFFFD", "");
            response = response.replaceAll("\\\\n", "");
            response = response.replaceAll("\\*", "");
            response = response.replaceAll("#", "");
            response = response.replaceAll("(?<!\\\\)(\\\\[^\\\\n])|\\\\", "");
            return response.replaceAll("[\r\n]", "");
        }
        return "";
    }


    public JSONObject executeGptPlus(String query, String name, JSONObject jsonObject1, String model) {
        JSONObject jsonObject = new JSONObject();
        String modelName = model;
        if (StringUtils.isEmpty(model)) {
            modelName = "gpt-4o-mini";
        }
        String result = youyideyi(query, jsonObject1, modelName);
        log.info(name + "进行了分析");
        log.info("GPT分析的问题是:{}", query);
        log.info("----经过GPT分析出来的结果是{}", result);
        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
        return jsonObject;
    }


    private String getPrompt(TraditionalPromptEnum promptEnum) {
        JSONObject prompt = mongoTemplate.findOne(new Query(Criteria.where("promptKey").is(promptEnum.getKey())), JSONObject.class);
        if (ObjectUtil.isNotEmpty(prompt)) {
            return prompt.getString("promptContent");
        } else {
            return promptEnum.getDefaultPrompt();
        }
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


    public TrInheritanceEvaluationDto getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew){
        TrInheritanceEvaluationDto trInheritanceEvaluationDto = new TrInheritanceEvaluationDto();
        String recipeSourcePrompt = "你作为一名专业的药物研究员，对药品的处方以及组方来源非常清楚。药品"+drugInfoNew.getDrugName()+"," +(StringUtils.isNotEmpty(drugInfoNew.getIngredient())?"请基于药品成份：***"+drugInfoNew.getIngredient()+"***":"")+
                "请分析一下以上这个药品的组方的来源是以下四个中的哪一个？（单选）\n" +
                "1、完全来源于某个古代经典名方；\n" +
                "2、以古代经典名方（历代医籍中记载的著名方剂）为基本框架，根据现代疾病特点或患者个体情况，对原方的药物组成、剂量或配伍进行调整，从而形成新的方剂；\n" +
                "3、由名老中医方或医院制剂转化；\n" +
                "4、研制方。\n" +
                "请注意：\n" +
                "1、若是来源于古代经典名方，需要给出具体的代经典名方名称；\n" +
                "2、若是以古代经典名方为基本框架进行药物的调整，需要给出具体调整了哪些方面；\n" +
                "3、若是由名老中医方或医院制剂转化而来，需要给出具体的名老中医姓名或者医院名称及院内制剂名称；\n" +
                "4、若不是以上三个选项，就属于研制方。\n" +
                "最终，结合以下评分规则给出最终的分值（单选）：\n" +
                "完全来源古代经典名方：10分\n" +
                "古代经典名方基础上化裁：9分\n" +
                "老中医方或医院制剂转化：8分\n" +
                "研制方：7分";

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("content", "原因(中文回答)");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        JSONObject recipeSourceResult = lxGptService.executeGptPlus(recipeSourcePrompt, "组方来源", responseFormat, "","10,9,8,7");
        String recipeSourceResultContent = recipeSourceResult.getString("content");
        trInheritanceEvaluationDto.setRecipeSourceContent(recipeSourceResultContent);
        String recipeSourceResultScore = recipeSourceResult.getString("score");
        trInheritanceEvaluationDto.setRecipeSourceScore(extractLastNumber(recipeSourceResultScore));


        //理论支持
        String theorySupportPrompt1 = "你作为一名专业的中药研究研究员，" +(StringUtils.isNotEmpty(drugInfoNew.getIngredient())?"请基于药品成份：***"+drugInfoNew.getIngredient()+"***":"") +
                " 分析一下"+drugInfoNew.getDrugName()+"研发的理论支撑：\n" +
                "（1）是否是基于中医药理论指导开发；\n" +
                "（2）是否遵循中医药的君臣佐使配伍原则；\n" +
                "（3）君臣药的药性、归经与治疗目标相符；\n" +
                "（4）君臣药的炮制品选择与治疗目标相符。\n" +
                "并结合以下评分规则给出最终得分：（多选）\n" +
                "基于中医药理论指导开发：2分\n" +
                "遵循中医药的君臣佐使配伍原则：2分\n" +
                "君臣药的药性、归经与治疗目标相符：1分\n" +
                "君臣药的炮制品选择与治疗目标相符：1分\n";

        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap1.put("content", "原因(中文回答)");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
        JSONObject theorySupportResult1 = lxGptService.executeGptPlus(theorySupportPrompt1, "药理支持", responseFormat1, "","2,1");
        String theorySupportResult1Content = theorySupportResult1.getString("content");
        String theorySupportResult1Score = theorySupportResult1.getString("score");

//        String theorySupportPrompt2 = "中成药"+drugInfoNew.getDrugName()+"中君臣药的炮制品选择与治疗目标相符）然后再根据评分规则进行打分，最高1分，最低0分";
//        JSONObject theorySupportResult2 = lxGptService.executeGptPlus(theorySupportPrompt2, "炮制支持", responseFormat, "");
//        String theorySupportResult2Content = theorySupportResult2.getString("content");
//        String theorySupportResult2Score = theorySupportResult2.getString("score");
//
//        String gpt = lxGptService.getGpt(drugInfoNew.getDrugName() + "是否属于提取物或者饮片，回复是或者否，不要其他内容", "");
//        double theorySupport = 2;
//        String content = "该药品为上市药品";
//        if (!gpt.contains("是")) {
//            content +="该药品不遵循中医药的君臣佐使配伍原则，属于提取物或饮片";
//        }else {
//            theorySupport += 2;
//            content +="该药品遵循中医药的君臣佐使配伍原则，属于组方";
//        }
//
//        theorySupport += Integer.parseInt(theorySupportResult1Score);
//        content+="\n"+theorySupportResult1Content;
//
//        theorySupport += Integer.parseInt(theorySupportResult2Score);
//        content+="\n"+theorySupportResult2Content;

        trInheritanceEvaluationDto.setTheorySupportContent(theorySupportResult1Content);
        trInheritanceEvaluationDto.setTheorySupportScore(extractLastNumber(theorySupportResult1Score));



        //病证结合
        String diseaseCombinationPrompt = "你作为一名专业的中药药师，"+(StringUtils.isNotEmpty(drugInfoNew.getIngredient())?"请基于药品成份：***"+drugInfoNew.getIngredient()+"***":"") +
                "分析一下"+drugInfoNew.getDrugName()+"功能主治中疾病、证候、症状是否描述精确？\n" +
                "以下为说明书中功能主治原文：****"+drugInfoNew.getIndications()+"****\n" +
                "请结合以下评分规则，针对以上功能主治内容进行评分，并给出最终分值：（最高6分）\n" +
                "功能主治中疾病、证候、症状均描述精准：5分\n" +
                "功能主治中疾病或证候或症状描述清楚：3分\n" +
                "功能主治内容中如果包含西医疾病名称，需要额外加1分\n" +
                "请注意：\n" +
                "如果功能主治内容中如没有西医疾病名称，则不要额外加分。";
        JSONObject diseaseCombination = lxGptService.executeGptPlus(diseaseCombinationPrompt, "病证结合", responseFormat, "","6,5,4,3,1");
        String diseaseCombinationContent = diseaseCombination.getString("content");
        String diseaseCombinationScore = diseaseCombination.getString("score");
        trInheritanceEvaluationDto.setDiseaseCombinationContent(diseaseCombinationContent);
        trInheritanceEvaluationDto.setDiseaseCombinationScore(extractLastNumber(diseaseCombinationScore));

        trInheritanceEvaluationDto.setTotalScore();
        return trInheritanceEvaluationDto;

    }


    public TrClinicalEvaluationDto getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew){
        TrClinicalEvaluationDto trClinicalEvaluationDto = new TrClinicalEvaluationDto();
        String clinicalPositioningPrompt = "你作为一名专业的中药药师，"+(StringUtils.isNotEmpty(drugInfoNew.getIngredient())?"请基于药品成份：***"+drugInfoNew.getIngredient()+"***":"")+
        "分析一下"+drugInfoNew.getDrugName()+"是否曾经或者现在正在被用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗？若是，请直接给5分，同时不再进行其他分析。\n" +
                "若不是，需要分析下药品在治疗疾病时的治疗作用，是属于主要治疗药品，还是辅助药品？\n" +
                "请结合以下评分规则进行打分：（单选）\n" +
                "用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗：5分\n" +
                "相关疾病的治疗作用或缓解疾病过程中出现的各种不适症状：3分\n" +
                "辅助主要治疗手段，对疾病恢复起到促进作用：1分\n"
                ;
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("content", "分析过程(中文回答)");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        JSONObject clinicalPositioning = lxGptService.executeGptPlus(clinicalPositioningPrompt, "临床定位", responseFormat, "","5,3,1");
        String clinicalPositioningContent = clinicalPositioning.getString("content");
        String clinicalPositioningScore = clinicalPositioning.getString("score");

        trClinicalEvaluationDto.setClinicalPositioningContent(clinicalPositioningContent);
        trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber(clinicalPositioningScore));


        //临床研究


        String drugZh = drugInfoNew.getDrugZh();
        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugZh);
        drugZhs.addAll(drugInfoNew.getDrugSynonymZh());
        drugZhs.remove("");
        drugZhs.add(drugInfoNew.getDrugName());
        StringBuilder stringBuilder = new StringBuilder();
        StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", stringBuilder1.toString());
        jsonObject.put("type", "1");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
        TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 0);
        TermQueryBuilder termQueryBuilder2 = QueryBuilders.termQuery("lastNewType", 2);
        ArrayList<Integer> integers = new ArrayList<>();
        integers.add(3);
        integers.add(5);
        TermsQueryBuilder termQueryBuilder3 = QueryBuilders.termsQuery("lastNewType", integers);
        ArrayList<Integer> integers1 = new ArrayList<>();
        integers1.add(4);
        integers1.add(6);
        integers1.add(7);
        TermsQueryBuilder termQueryBuilder4 = QueryBuilders.termsQuery("lastNewType", integers1);


        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder boolQueryBuilder2 = new BoolQueryBuilder();
        BoolQueryBuilder boolQueryBuilder3 = new BoolQueryBuilder();
        BoolQueryBuilder boolQueryBuilder4 = new BoolQueryBuilder();

        boolQueryBuilder.must().add(wrapperQueryBuilder);
        boolQueryBuilder.must().add(termQueryBuilder);

        boolQueryBuilder2.must().add(wrapperQueryBuilder);
        boolQueryBuilder2.must().add(termQueryBuilder2);

        boolQueryBuilder3.must().add(wrapperQueryBuilder);
        boolQueryBuilder3.must().add(termQueryBuilder3);

        boolQueryBuilder4.must().add(wrapperQueryBuilder);
        boolQueryBuilder4.must().add(termQueryBuilder4);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        Sort sort = Sort.by(Sort.Order.desc("year"));
        PageRequest pageRequest = PageRequest.of(0, 10);
        nativeSearchQuery.addSort(sort);
        nativeSearchQuery.setPageable(pageRequest);
        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(boolQueryBuilder2);
        nativeSearchQuery2.addSort(sort);
        nativeSearchQuery2.setPageable(pageRequest);
        NativeSearchQuery nativeSearchQuery3 = new NativeSearchQuery(boolQueryBuilder3);
        nativeSearchQuery3.addSort(sort);
        nativeSearchQuery3.setPageable(pageRequest);
        NativeSearchQuery nativeSearchQuery4 = new NativeSearchQuery(boolQueryBuilder4);
        nativeSearchQuery4.addSort(sort);
        nativeSearchQuery4.setPageable(pageRequest);

        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        SearchHits<Literature> literatureSearchHits2 = this.elasticsearchRestTemplate.search(nativeSearchQuery2, Literature.class);
        SearchHits<Literature> literatureSearchHits3 = this.elasticsearchRestTemplate.search(nativeSearchQuery3, Literature.class);
        SearchHits<Literature> literatureSearchHits4 = this.elasticsearchRestTemplate.search(nativeSearchQuery4, Literature.class);

        if (literatureSearchHits.getTotalHits() > 0){
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "("+count+")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(5.0);
        }else if (literatureSearchHits2.getTotalHits() > 0){
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits2) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "("+count+")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(4.0);
        }else if (literatureSearchHits3.getTotalHits() > 0){
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits3) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "("+count+")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(2.0);
        }else if (literatureSearchHits4.getTotalHits() > 0){
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits4) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "("+count+")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(1.0);
        } else {
            trClinicalEvaluationDto.setClinicalResearchContent("未找到相关文献");
            trClinicalEvaluationDto.setClinicalResearchScore(0.0);
        }


        //证据推荐
        List<GuideVO> guideVOS = getGuideWithCache(drugZhs, drugInfoNew.getDrugZh());
        if (guideVOS.size() > 0){
            if (guideVOS.size() > 10){
                guideVOS = guideVOS.subList(0, 10);
            }
            for (GuideVO guideVO : guideVOS) {
                TrClinicalEvaluationDto.EvidenceItem evidenceItem = new TrClinicalEvaluationDto.EvidenceItem(guideVO.getTitle(), guideVO.getPdf_txt());
                trClinicalEvaluationDto.getEvidenceItems().add(evidenceItem);
            }
            trClinicalEvaluationDto.setEvidenceRecommendationScore(10.0);
        }

//        //临床需求
//        trClinicalEvaluationDto.setClinicalDemandOption("填补本院用药目录空白");
        trClinicalEvaluationDto.setClinicalDemandScore(0.0);
        trClinicalEvaluationDto.setTotalScore();
        return trClinicalEvaluationDto;


    }


    public List<GuideVO> getGuideWithCache(List<String> drugZhs, String drugZh) {
        // 构建缓存键
        String cacheKey = "guide:" + drugZh;

        // 尝试从 Redis 缓存中获取数据
        List<GuideVO> guideVOS = (List<GuideVO>) redisTemplate.opsForValue().get(cacheKey);

        if (guideVOS == null) {
            // 缓存中不存在数据，执行查询
            guideVOS = lxGptService.queryGuideByDrugAndDisease(drugZhs, drugZh, null, "");

            if (guideVOS != null) {
                // 将查询结果存入 Redis 缓存，设置缓存过期时间，例如 1 小时
                redisTemplate.opsForValue().set(cacheKey, guideVOS, 1, TimeUnit.HOURS);
            }
        }

        return guideVOS;
    }


    public static double extractLastNumber(String input) {
        if (input == null || input.isEmpty()) {
            return 0.0;
        }

        // 定义正则表达式，匹配一个或多个数字（包括小数）
        String regex = "\\d+(\\.\\d+)?";
        Pattern pattern = Pattern.compile(regex);
        Matcher matcher = pattern.matcher(input);

        String lastNumber = null;
        // 查找所有匹配的数字
        while (matcher.find()) {
            lastNumber = matcher.group();
        }

        // 返回最后一个匹配的数字，若无匹配则返回0.0
        return lastNumber != null ? Double.parseDouble(lastNumber) : 0.0;
    }


    //安全性内容
    public TrSafetyEvaluationDto getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew){
        TrSafetyEvaluationDto trSafetyEvaluationDto = new TrSafetyEvaluationDto();
        //不良反应描述
        String adverseReactionPrompt = "你作为一名专业的中药药师，根据"+drugInfoNew.getDrugName()+"说明书中以下不良反应以及禁忌原文信息，" +
                "分析一下这两个模块中，是否存在“尚不明确”等模糊字眼，若任意一个模块存在“尚不明确”，给0分；若全部模块均不存在“尚不明确”，给2分。" +
                "【不良反应】："+drugInfoNew.getAdverseReaction()+"\n" +
                "【禁忌】："+drugInfoNew.getContraindications() ;
        String gpt = lxGptService.getGpt(adverseReactionPrompt, "","2,0");
        trSafetyEvaluationDto.setAdverseReactionScore(extractLastNumber(gpt));
        String content = "";
        if (StringUtils.isNotEmpty(drugInfoNew.getAdverseReaction())){
            drugInfoNew.setAdverseReaction(drugInfoNew.getAdverseReaction().replaceAll("\\n",""));
            content += "【不良反应】"+drugInfoNew.getAdverseReaction();
        }
        if (StringUtils.isNotEmpty(drugInfoNew.getContraindications())){
            drugInfoNew.setContraindications(drugInfoNew.getContraindications().replaceAll("\\n",""));
            content +="\n"+ "【禁忌】"+drugInfoNew.getContraindications();
        }
        if (StringUtils.isEmpty(content)){
        content = "说明书中无【不良反应】与【禁忌】相关内容。";
        }
        trSafetyEvaluationDto.setAdverseReactionContent(content);
        if (content.contains("尚不明确")){
            trSafetyEvaluationDto.setAdverseReactionScore(0.0);
        }

        //警告提示
        String warningNotePrompt = "你作为一名专业的中药药师，根据"+drugInfoNew.getDrugName()+"说明书中以下警示语以及注意事项原文信息，" +
                "【警告提示】："+drugInfoNew.getDrugWarning()+"\n" +
                "【注意事项】："+drugInfoNew.getNotes()+
        "分析一下两个模块中任意一个模块中，是否有可以提示用户某种情况下可以避免或者减轻药物不良反应的相关内容，若是，给2分；若没有提及，给0分。" +
                "返回一个具体得分（只要阿拉伯数字）"
               ;
        String gpt1 = lxGptService.getGpt(warningNotePrompt, "","2,0");


        if (StringUtils.isNotEmpty(drugInfoNew.getDrugWarning())&&StringUtils.isNotEmpty(drugInfoNew.getNotes())){

            trSafetyEvaluationDto.setWarningNoteContent("【警告语】："+drugInfoNew.getDrugWarning()+"\n" +
                    "【注意事项】："+drugInfoNew.getNotes());
        }else if (StringUtils.isNotEmpty(drugInfoNew.getNotes())){
            trSafetyEvaluationDto.setWarningNoteContent(  "【警告语】：无"+"\n" +
                    "【注意事项】："+drugInfoNew.getNotes());
        }else  if (StringUtils.isNotEmpty(drugInfoNew.getDrugWarning())){
            trSafetyEvaluationDto.setWarningNoteContent("【警告语】："+drugInfoNew.getDrugWarning()+"\n" +
                    "【注意事项】：无");
        } else {
            trSafetyEvaluationDto.setWarningNoteScore(0.0);
            trSafetyEvaluationDto.setWarningNoteContent("无相关警示或者注意事项");
        }

        trSafetyEvaluationDto.setWarningNoteScore(extractLastNumber(gpt1));
        //辅料
        if (StringUtils.isNotEmpty(drugInfoNew.getIngredient())&&drugInfoNew.getIngredient().contains("辅料")){
            trSafetyEvaluationDto.setExcipientScore(1.0);
            trSafetyEvaluationDto.setExcipient(drugInfoNew.getIngredient());
        }else {
            trSafetyEvaluationDto.setExcipientScore(0.0);
            trSafetyEvaluationDto.setExcipient("说明书无辅料相关内容");
        }

        //安全性再评价
        String drugZh = drugInfoNew.getDrugZh();
        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugZh);
        drugZhs.addAll(drugInfoNew.getDrugSynonymZh());
        drugZhs.remove("");
        drugZhs.add(drugInfoNew.getDrugName());
        StringBuilder stringBuilder = new StringBuilder();
        StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
        stringBuilder1.append(" AND ");
        ArrayList<String> strings = new ArrayList<>();
        strings.add("安全性");
        StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "标题");
        stringBuilder1.append(" NOT ");
        ArrayList<String> strings1 = new ArrayList<>();
        strings1.add("有效");
        strings1.add("疗效");
        strings1.add("效果");
        StringBuilder stringBuilder3 = PromptUtil.montageForPaper(stringBuilder2, strings1, "标题");
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", stringBuilder3.toString());
        jsonObject.put("type", "1");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);

        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(wrapperQueryBuilder);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        if (literatureSearchHits.getTotalHits() > 0){
            String string = "";
            boolean flag = false;
            boolean ismetaAndFlags = false;
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {

                String title = literatureSearchHit.getContent().getTitle();
                String id = literatureSearchHit.getContent().getId();
                MongoLiterature paper = fineScreenFeign.paper(id);
                log.info("title:{},id:{},paper:{}",title,id,paper.getMethod());
                if (StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr())&&
                        (literatureSearchHit.getContent().getSummary().contains("单中心")||
                                literatureSearchHit.getContent().getSummary().contains("多中心"))){
                    flag = true;
                }else {
                    if (literatureSearchHit.getContent().getLastNewType().contains("0")){
                        ismetaAndFlags = true;
                    }
                }
                string += "("+count+")《" + title + "》\n";
                if (StringUtils.isNotEmpty(paper.getMethod())){
                    string += "研究方法：" +paper.getMethod()+"\n";
                }else {
                    string +="摘要：" +literatureSearchHit.getContent().getSummary()+"\n";
                }
                count++;
            }

            trSafetyEvaluationDto.setSafetyReevaluationContent(string);
            if (!flag){
                if (ismetaAndFlags){
                    trSafetyEvaluationDto.setSafetyReevaluationScore(1.0);
                }
            }else {
                trSafetyEvaluationDto.setSafetyReevaluationScore(3.0);
            }
        }else {
            trSafetyEvaluationDto.setSafetyReevaluationScore(0.0);
            trSafetyEvaluationDto.setSafetyReevaluationContent("未找到安全性相关内容");
        }

        //人群限制
        //儿童
        String childPrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.toString()+"*****，" +
                "请抽提出以上原文信息中所有与儿童用药相关内容，总结出儿童是否可用，并结合以下评分规则给出最终得分：\n" +
                "3岁以下儿童可用：2分\n" +
                "3~5岁儿童可用：1.5分\n" +
                "6~10岁儿童可用：1分\n" +
                "11-16岁儿童可用：0.5分\n" +
                "所有儿童可用：2分\n" +
                "请注意：\n" +
                "（1）只要说明书中未明确提及儿童不能用时，均认为可用，根据评分规则给分；\n" +
                "（2）当出现“在医生指导下使用”时，算作可用，给2分；\n" +
                "（3）当给出的内容中没有明确儿童的具体年龄时，将其认为是所有儿童。\n" +
                "（4）儿童用药情况尚无证据时，给0分。" ;
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content","挑选出的关于儿童用药的相关内容(中文回答)");
        stringStringHashMap.put("score","打分（务必是数字:int或者double类型，其他的内容不要）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        JSONObject jsonObject1 = lxGptService.executeGptPlus(childPrompt, "child", responseFormat, "","2,1.5,1,0.5");
        trSafetyEvaluationDto.setPediatricDrugUseScore(extractLastNumber(jsonObject1.getString("score")));
        trSafetyEvaluationDto.setPediatricDrugUseContent(jsonObject1.getString("content"));

        //妊振期妇女
        String pregnancyPrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.toString()+"*****，" +
                "请抽提出以上原文信息中所有与妊娠期妇女用药相关内容，总结出妊娠期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "妊娠期妇女可用；1分\n" +
                "妊娠期妇女慎用：0.5分\n" +
                "妊娠期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（3）没有明确妊娠期妇女相关信息时，认为是尚不明确。\n" ;
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content","挑选出的关于孕妇及哺乳期妇女用药的相关内容(中文回答)");
        stringStringHashMap1.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
        JSONObject jsonObject2 = lxGptService.executeGptPlus(pregnancyPrompt, "pregnancy", responseFormat1, "","1,0.5,0");
        trSafetyEvaluationDto.setPregnancyDrugUseScore(extractLastNumber(jsonObject2.getString("score")));
        trSafetyEvaluationDto.setPregnancyDrugUseContent(jsonObject2.getString("content"));

        //哺乳期妇女
        String lactationPrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.toString()+"*****，" +
                "请抽提出以上原文信息中所有与哺乳期妇女用药相关内容，总结出哺乳期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "哺乳期妇女可用；1分\n" +
                "哺乳期妇女慎用：0.5分\n" +
                "哺乳期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（3）没有明确哺乳期妇女相关信息时，认为是尚不明确。\n" ;
        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content","挑选出的关于哺乳期妇女用药的相关内容(中文回答)");
        stringStringHashMap2.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
        JSONObject jsonObject3 = lxGptService.executeGptPlus(lactationPrompt, "lactation", responseFormat2, "","1,0.5,0");
        trSafetyEvaluationDto.setLactationDrugUseScore(extractLastNumber(jsonObject3.getString("score")));
        trSafetyEvaluationDto.setLactationDrugUseContent(jsonObject3.getString("content"));

        if (!drugInfoNew.toString().contains("肝")){
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent("尚不明确");
        }else {
            //肝功能异常
            String liverPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与肝相关的内容，总结出肝功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                    "肝功能异常可用；1分\n" +
                    "肝功能异常慎用：0.5分\n" +
                    "肝功能异常禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（3）没有明确提及与肝相关信息时，认为是尚不明确。\n";
            HashMap<String, String> stringStringHashMap3 = new HashMap<>();
            stringStringHashMap3.put("content", "挑选出的关于肝功能异常用药的相关内容");
            stringStringHashMap3.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat3 = getResponseFormat(stringStringHashMap3);
            JSONObject jsonObject4 = lxGptService.executeGptPlus(liverPrompt, "liver", responseFormat3, "","1,0.5,0");
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(extractLastNumber(jsonObject4.getString("score")));
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent(jsonObject4.getString("content"));
        }
        if (!drugInfoNew.toString().contains("肾")){
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent("尚不明确");
        }else {

            //肾功能异常
            String kidneyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与肾相关的内容，总结出肾功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                    "肾功能异常可用；1分\n" +
                    "肾功能异常慎用：0.5分\n" +
                    "肾功能异常禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（3）没有明确提及与肾相关信息时，认为是尚不明确。\n";
            HashMap<String, String> stringStringHashMap4 = new HashMap<>();
            stringStringHashMap4.put("content", "挑选出的关于肾功能异常用药的相关内容");
            stringStringHashMap4.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat4 = getResponseFormat(stringStringHashMap4);
            JSONObject jsonObject5 = lxGptService.executeGptPlus(kidneyPrompt, "kidney", responseFormat4, "","1,0.5,0");
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(extractLastNumber(jsonObject5.getString("score")));
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent(jsonObject5.getString("content"));
        }
        if (!drugInfoNew.toString().contains("运动员")){
            trSafetyEvaluationDto.setAthleteDrugUseScore(1.0);
            trSafetyEvaluationDto.setAthleteDrugUseContent("未明确提及运动员相关信息，认为运动员可用");
        }else {
            //运动
            String athletePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与运动员相关的内容，总结出运动员是否可用，并结合以下评分规则给出最终得分：\n" +
                    "运动员可用；1分\n" +
                    "运动员慎用：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，根据评分规则给分；\n" +
                    "（3）没有明确提及与运动员相关信息时，认为是可用。\n" +
                    "'''";
            HashMap<String, String> stringStringHashMap5 = new HashMap<>();
            stringStringHashMap5.put("content", "挑选出的关于运动员用药的相关内容");
            stringStringHashMap5.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat5 = getResponseFormat(stringStringHashMap5);
            JSONObject jsonObject6 = lxGptService.executeGptPlus(athletePrompt, "athlete", responseFormat5, "","1,0");
            trSafetyEvaluationDto.setAthleteDrugUseScore(extractLastNumber(jsonObject6.getString("score")));
            trSafetyEvaluationDto.setAthleteDrugUseContent(jsonObject6.getString("content"));
        }

        trSafetyEvaluationDto.setSafetyInfoScore();


        //不良反应分级
        String adverPrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****【不良反应】："+drugInfoNew.getAdverseReaction()+
                "【注意事项】："+drugInfoNew.getNotes()+"*****，" +
                "请基于以上内容，分析一下药品不良反应症状如何，并结合以下评分规则给出最终得分（单选）：\n" +
                "不良反应症状轻微，无需治疗或改变给药方案：5分\n" +
                "不良反应症状明显，需要干预治疗或改变给药方案：3分\n" +
                "不良反应症状严重，需立刻采取解救手段且改变给药方案：1分\n" +
                "注意：内容要中文回答" ;
        HashMap<String, String> stringStringHashMap6 = new HashMap<>();
        stringStringHashMap6.put("content","判断发生不良反应后，是否需要改变给药方案(中文回答)");
        stringStringHashMap6.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat6 = getResponseFormat(stringStringHashMap6);
        JSONObject jsonObject7 = lxGptService.executeGptPlus(adverPrompt, "adver", responseFormat6, "","5,3,1");
        trSafetyEvaluationDto.setAdverseReactionStratificationScore(extractLastNumber(jsonObject7.getString("score")));
        trSafetyEvaluationDto.setAdverseReactionStratificationContent(jsonObject7.getString("content"));
        trSafetyEvaluationDto.setCrowdRestrictionScore();
        trSafetyEvaluationDto.setTotalScore();

        return trSafetyEvaluationDto;

    }


    //技术评价
    public TrTechnologyEvaluationDto getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew) {
        TrTechnologyEvaluationDto trTechnologyEvaluationDto = new TrTechnologyEvaluationDto();
        //频次
        String prompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.getUsageAndDosage()+"*****，" +
                "1.请帮我挑选出药品用药频次相关的内容，如果没有相关的则返回说明书未提及用药频次相关内容\n" +
                "2.请帮我打分，每日1次得2分，每日2次得1.5分，每日3次得1分，每日4次及以上" +
                "不得分,暂无内容得0分\n" +
                "注意：内容要中文回答" ;
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content","药品用药频次相关的内容(中文回答)");
        stringStringHashMap.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        JSONObject jsonObject = lxGptService.executeGptPlus(prompt, "frequency", responseFormat, "","2,1.5,1,0.5");
        trTechnologyEvaluationDto.setAdministrationFrequencyScore(extractLastNumber(jsonObject.getString("score")));
        trTechnologyEvaluationDto.setAdministrationFrequencyContent(jsonObject.getString("content"));

        //包装规格
       //todo 先直接赋值
        trTechnologyEvaluationDto.setPackagingSpecificationScore(0.0);
        trTechnologyEvaluationDto.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");

        //大包装
        //todo 先直接赋值
        trTechnologyEvaluationDto.setLargePackageAdoptionScore(0.0);
        trTechnologyEvaluationDto.setLargePackageAdoptionOption("最小包装使用人次数高于对照药");

        //单剂量
        //todo 先直接赋值
        trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
        trTechnologyEvaluationDto.setSingleDoseScore(0.0);

        //疗程
        String coursePrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.toString()+"*****，" +
                "1.请帮我挑选出药品疗程相关的内容，如果没有相关的则返回暂无疗程相关内容 +\n" +
                "2.请帮我打分，对疗程有明确限定1分，无内容0分\n" +
                "注意：内容要中文回答" ;
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content","药品疗程相关的内容(中文回答)");
        stringStringHashMap1.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
        JSONObject jsonObject1 = lxGptService.executeGptPlus(coursePrompt, "course", responseFormat1, "","1,0");
        trTechnologyEvaluationDto.setCourseOfTreatmentScore(extractLastNumber(jsonObject1.getString("score")));
        trTechnologyEvaluationDto.setCourseOfTreatmentContent(jsonObject1.getString("content"));

        //存储
        String storagePrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.getStorage()+"*****，" +
                "作为一名专业的药师，请根据说明书原文内容，结合以下打分规则进行评分。\n" +
                "1分：常温贮藏\n" +
                "0.5分：需阴凉或避光/遮光贮藏\n" +
                "注意：当说明书中【贮藏】中明确提及“阴凉”、“20℃以下”、“遮光”、“避光”等时，直接给0.5分,反之，需要给1分。\n只返回一个数字，不要其他的内容";
        String gpt = lxGptService.getGpt(storagePrompt, "","1,0.5");
        trTechnologyEvaluationDto.setStorageScore(extractLastNumber(gpt));
        trTechnologyEvaluationDto.setStorageContent(drugInfoNew.getStorage());

        //有效期
        String validityPrompt = "药品"+drugInfoNew.getDrugName()+"说明书如下*****"+drugInfoNew.getIndate()+"*****，" +
                "请帮我打分，药品有效期大于24个月1分，小于24个月0分，只返回一个数字" ;
        String gpt1 = lxGptService.getGpt(validityPrompt, "","1,0");
        trTechnologyEvaluationDto.setValidityPeriodScore(extractLastNumber(gpt1));
        trTechnologyEvaluationDto.setValidityPeriodContent(drugInfoNew.getIndate());

        //保护品种
        if (StringUtils.isNotEmpty(drugInfoNew.getIsProtected())) {
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(2.0);
            String protectionLevel = drugInfoNew.getProtectionLevel();
            if (StringUtils.isNotEmpty(protectionLevel)){
                trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent("该产品为国家保护品种，"+protectionLevel);
                if(protectionLevel.contains("1级")){
                    trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(3.0);
                }else if(!protectionLevel.contains("2级")){
                    trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(2.0);
                }
            }else {
                trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent("该产品为国家保护品种。");
                trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(2.0);
            }
        }else{
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent("该产品不是国家保护品种");
        }


        //药典
        if (StringUtils.isNotEmpty(drugInfoNew.getIsInclude())&&"收载在《中国药典》中。".equals(drugInfoNew.getIsInclude())){
            String chineseMedicine = "本品已收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(1.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);

        }else {
            String chineseMedicine = "本品未收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(0.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
        }


        //专利
        //使用prompt
        String patentsPrompt = "药品"+drugInfoNew.getDrugName()+"中成药是否获得过专利？若有，请提供准确的专利号，若无，请不要提供虚假或者假设信息，直接输出'暂未查询到药品的相关专利信息。'就可以。";
        String gpt2 = lxGptService.getGpt(patentsPrompt, "","");
        if (gpt2.contains("无相关专利")||gpt2.contains("暂未查询到药品的相关专利信息")) {
            trTechnologyEvaluationDto.setPatentScore(0.0);
            trTechnologyEvaluationDto.setPatentNumber("暂未查询到药品的相关专利信息。");
        }else {
            trTechnologyEvaluationDto.setPatentScore(1.0);
            trTechnologyEvaluationDto.setPatentNumber(gpt2);
        }

        //是否是独家品种
        List<DrugInfoNew> drugName = mongoTemplate.find(Query.query(Criteria.where("drugName").is(drugInfoNew.getDrugName())), DrugInfoNew.class);
        HashSet<String> strings = new HashSet<>();
        for (DrugInfoNew infoNew : drugName) {
            strings.add(infoNew.getManufacturer());
        }


        if (strings.size()<=1){
            trTechnologyEvaluationDto.setExclusiveVarietyScore(1.0);
            trTechnologyEvaluationDto.setExclusiveVarietyInfo("该药品是独家品种");
        }else if (strings.size()>1){
            trTechnologyEvaluationDto.setExclusiveVarietyScore(0.0);
            String s = "";
            for (String string : strings) {
                s+=drugInfoNew.getDrugName()+"-"+string+"\n";
            }
            trTechnologyEvaluationDto.setExclusiveVarietyInfo("该药品不是独家品种");
            trTechnologyEvaluationDto.setExclusiveVarietyInfo(s.substring(0,s.length()-2));
        }

        //生产企业情况
        //prompt判断
        String productionEnterpriseStatusPrompt = "药品"+drugInfoNew.getDrugName()+"企业为*****"+drugInfoNew.getManufacturer()+"*****，" +
                "2023年度中国医药工业百强企业：\n" +
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
                "100\t郑州安图生物工程股份有限公司\n" +
                "\n" +
                "2023年度中国中药企业TOP100排行榜\n" +
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
                "100\t李时珍医药集团有限公司\n" +
                "\n" +
                "2024中药老字号品牌TOP50\n" +
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
                "50\t群星\t广州白云山星群(药业)股份有限公司" +
                "请结合以上企业排名数据，并根据以下评分规则给出分值：（单选，最高3分）\n" +
                "生产企业在工信部医药工业百强榜/老字号中药品牌：3分\n" +
                "生产企业在中国中药企业TOP100排行榜：2分\n" +
                "其他企业：1分\n" +
                "\n" +
                "注意：\n" +
                "（1）当药品生产企业在2024年中药老字号品牌TOP50时，给3分；\n" +
                "（2）当药品生产企业在2023年度中国医药工业百强企业中时，给3分；\n" +
                "（3）当药品生产企业在2023年度中国中药企业TOP100排行榜时，给2分；\n" +
                "（4）当不属于前三者时，属于其他企业，给1分。\n" +
                "（5）当厂家名称隶属于以上表格中的生产企业名称时，请按照相应的评分规则给分，不要求厂家名称与表格中的生产企业名称写法完全一致，请加以判断。\n" +
                "示例：“太极集团重庆涪陵制药厂有限公司”隶属于“太极集团有限公司”，而“太极集团”在我提供的数据表的《中国中药企业TOP100排行榜》中，故给2分。" ;

        String productionEnterpriseStatusPromptx = "药品"+drugInfoNew.getDrugName()+"企业为*****"+drugInfoNew.getManufacturer()+"*****，" +
                "药品成分为："+drugInfoNew.getIngredient()+"，" +
                "请判断： 该生产企业是否拥有独立的GAP种植基地？若有，请给出种植基地种植的药物是什么？再请判断下这个GAP种植基地中种植的药物是否属于药品成份中的一个？" +
                "打分：有种植基地且属于成分，则返回1分，否则返回0分" ;

        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content","相关内容");
        stringStringHashMap2.put("score","打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
        JSONObject jsonObject2 = lxGptService.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", responseFormat2, "","3,2,1");
        JSONObject jsonObject3 = lxGptService.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", responseFormat2, "","1,0");

        trTechnologyEvaluationDto.setProductionEnterpriseStatusScore(extractLastNumber(jsonObject2.getString("score"))+extractLastNumber(jsonObject3.getString("score")));
        trTechnologyEvaluationDto.setProductionEnterpriseStatusContent(jsonObject2.getString("content")+"\n"+jsonObject3.getString("content"));
        trTechnologyEvaluationDto.setAdditionalZodiacScore();
        trTechnologyEvaluationDto.setSuitabilityScore();
        trTechnologyEvaluationDto.setTotalScore();
        return trTechnologyEvaluationDto;

    }

    //市场评价
    public TrMarketEvaluationDto getTrMarketEvaluationDto(DrugInfoNew drugInfoNew) {
        //市场独特性
        //todo  先直接赋值
        TrMarketEvaluationDto trMarketEvaluationDto = new TrMarketEvaluationDto();
        trMarketEvaluationDto.setMarketUniquenessScore(0.0);
        trMarketEvaluationDto.setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");

        //经济性
        trMarketEvaluationDto.setEconomicScore(0.0);
        trMarketEvaluationDto.setEconomicOption("日均治疗费用较同类中成药价格较低，且具有明显的药物经济学优势");

        //国家基本药物
        String essentialMedicines = drugInfoNew.getEssentialMedicines();
        if (StringUtils.isNotEmpty(essentialMedicines)&&"是".equals(essentialMedicines)) {
            trMarketEvaluationDto.setNationalEssentialDrugsScore(3.0);
            trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品被《国家基本药物目录》收载");
        }else {
            trMarketEvaluationDto.setNationalEssentialDrugsScore(0.0);
            trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品未被《国家基本药物目录》收载");
        }

        //医保
        String medicalInsuranceContent = "";
        boolean isInsurance = false;
        String medicalInsurance = drugInfoNew.getMedicalInsurance();
        if (StringUtils.isNotBlank(medicalInsurance)) {
            isInsurance = true;
        }

        // 医保得分
        double isInsuranceScore = 1.00F;
        if (isInsurance) {
            boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfoNew.getPaymentScope());
            if ("甲".equals(medicalInsurance)) {
                medicalInsuranceContent = "该药品属于医保甲类";
                if (paymentScopeStatus) {
                    isInsuranceScore = 2.50F;
                    medicalInsuranceContent += "，有支付限制，"+drugInfoNew.getPaymentScope()+"。";
                } else {
                    isInsuranceScore = 3.00F;
                    medicalInsuranceContent += "，无支付限制";
                }
            } else {
                medicalInsuranceContent = "该药品属于医乙类";
                if (paymentScopeStatus) {
                    isInsuranceScore = 1.50F;
                    medicalInsuranceContent += "，有支付限制，"+drugInfoNew.getPaymentScope()+"。";
                } else {
                    isInsuranceScore = 2.00F;
                    medicalInsuranceContent += "，无支付限制";
                }
            }
        }else {
            medicalInsuranceContent = "该药品不属于医保药品";
        }
        trMarketEvaluationDto.setNationalMedicalInsuranceDrugsScore(isInsuranceScore);
        trMarketEvaluationDto.setNationalMedicalInsuranceDrugsPaymentRequirement(medicalInsuranceContent);

        //集采
        boolean isConcentrate = true;
        String drugCollection = drugInfoNew.getDrugCollection();
        if ("不属于国家/联盟集中采购药品。".equals(drugCollection)) {
            isConcentrate = false;
        }
        if (isConcentrate) {
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsScore(1.0);
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsSource(drugCollection);
        }else {
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsScore(0.0);
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsSource(drugCollection);
        }
        trMarketEvaluationDto.setPolicyAttributeScore();
        trMarketEvaluationDto.setTotalScore();

        return trMarketEvaluationDto;


    }


}
