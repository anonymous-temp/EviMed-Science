package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.lowagie.text.*;
import com.lowagie.text.Font;
import com.lowagie.text.HeaderFooter;
import com.lowagie.text.Image;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.rtf.RtfWriter2;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.InformationTypeEnum;
import com.sentum.enums.VaeEnum;
import com.sentum.feign.FormulaFeign;
import com.sentum.pojo.*;
import com.sentum.pojo.dto.DrugAddDto;
import com.sentum.pojo.vo.DataResult;
import com.sentum.pojo.vo.DrugInst;
import com.sentum.pojo.vo.GuideVO;
import com.sentum.pojo.vo.Literature;
import com.sentum.service.GuideSearch;
import com.sentum.service.VaeService;
import com.sentum.util.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang.StringUtils;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.Row;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.WrapperQueryBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.DigestUtils;

import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.awt.Color;
import java.io.IOException;
import java.io.InputStream;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;
import java.util.stream.Collectors;


import org.apache.poi.ss.usermodel.*;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import static com.sentum.service.impl.StreamTrServiceImpl.extractLastNumber;
import static java.awt.Color.GRAY;


@Service
@Slf4j
public class VaeServiceImpl implements VaeService {


    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    EvaluationServiceImpl evaluationService;
    @Autowired
    LxGptServiceImpl lxGptService;

    @Autowired
    FormulaFeign formulaFeign;

    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    GptAiUtils gptAiUtils;

    @Autowired
    private GuideSearch guideSearch;


    @Autowired
    private GptCallUtil gptCallUtil;



    public Object guidePanel(String drugId, String disease, String id, HttpServletResponse response, String scaleId) {
        DrugInfoNew drugInfo = getDrugInfo(drugId, null);

        Vae vae = mongoTemplate.findById(scaleId, Vae.class);

        List<Vae.Dimension> dimensions = vae.getDimensions();


        write("start", drugInfo.getDrugName(), response, "药名");

        Double total = 0.0;
        // 计数器

        for (Vae.Dimension dimension : dimensions) {
            ResultJson resultJson = new ResultJson();
            resultJson.setScore(null);
            resultJson.setType("1");
            // 在标题中添加编号   如1
            dimension.setDimensionName(dimension.getDimensionName());
            resultJson.setTitle(dimension.getDimensionName());
            resultJson.setMaxScore(Double.valueOf(dimension.getDimensionScore()));
            // 一级标题书写
            write(resultJson, response);

            List<Vae.Item> items = dimension.getItems();

            // 二级计数器
            Double score = 0.0;
            for (Vae.Item item : items) {
                Double aDouble = 0.0;
                if (item.getResultType().equals("0")) {

                    // 只有二级的情况
                    item.setItemName(item.getItemName());
                    aDouble = doWrite(item, dimension, drugInfo, disease, response);
                } else {
                    // 有三级的情况    （多选的情况）
                    // 问题拆分
                    item.setItemName(item.getItemName());
                    aDouble = doWriteV2(item, dimension, drugInfo, response, disease);
                }
                score += aDouble;
            }
            ResultJson dimensionScore = new ResultJson();
            dimensionScore.setTitle(dimension.getDimensionName());
            dimensionScore.setScore(score);
            dimensionScore.setType("5");
            write(dimensionScore, response);
            total += score;

        }
        ResultJson totalScore = new ResultJson();
        totalScore.setTitle("总分");
        totalScore.setScore(total);
        totalScore.setType("5");
        write(totalScore, response);


        write("end", drugInfo.getDrugName(), response, "药名");


        JSONObject jsonObject = new JSONObject();

        return jsonObject;

    }


    private Double doWriteV2(Vae.Item item, Vae.Dimension dimension, DrugInfoNew drugInfo, HttpServletResponse response, String disease) {

        ResultJson resultJson1 = new ResultJson();
        resultJson1.setTitle(item.getItemName());
        resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
        resultJson1.setSuperiorTitle(dimension.getDimensionName());
        resultJson1.setType("4");
        write(resultJson1, response);
        String prompt = VaeEnum.VAE_TOTAL_V2.getDefaultValue() +
                item.getDetailedRules() + "JSON返回，无需额外说明,注意：最高总分为" + item.getItemScore();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content", "拆分出来的打分细则,string返回");
        stringStringHashMap.put("score", "可能出现的分数,string返回，分值用英文逗号隔开");
        stringStringHashMap.put("maxScore", "此项最高总分,number返回");
        stringStringHashMap.put("title", "打分维度,string返回");
        JSONObject formatJson = new JSONObject();
        JSONArray jsonArray = new JSONArray();
        for (int i =1; i < 3; i++ ){
            JSONObject object = new JSONObject();
            object.put("content", "拆分出来本项的打分细则,string返回");
            object.put("score", "本条可能出现的分数string返回，分值用英文逗号隔开");
            object.put("maxScore", "本条的最大分值,string返回");
            object.put("title", "本条打分的维度");
            jsonArray.add(object);
        }
        formatJson.put("array", jsonArray);

         String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
        List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class, "evaluation_vae_cache");
        JSONObject jsonObject;
        if (CollUtil.isNotEmpty( list)){
            jsonObject = list.get(0).getJSONObject("info");
        }else {
            jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格以json格式返回，具体格式："+formatJson, "", "");
            if (StringUtils.isNotEmpty(jsonObject.getString("array"))) {
                JSONObject object = new JSONObject();
                object.put("info", jsonObject);
                object.put("time", new Date());
                object.put("prompt", prompt);
                object.put("key", key);
                mongoTemplate.insert(object, "evaluation_vae_cache");
            }
        }

        JSONArray array = jsonObject.getJSONArray("array");
        Double totalScore = 0.0;
        for (int i = 0; i < array.size(); i++) {
            ResultJson resultJson = new ResultJson();
            resultJson.setType("2");
            resultJson.setSuperiorTitle(resultJson1.getTitle());
            resultJson.setTitle(array.getJSONObject(i).getString("title"));
            resultJson.setMaxScore(array.getJSONObject(i).getDouble("maxScore"));
            String string = array.getJSONObject(i).getString("score");
            String[] split = string.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::parseDouble)
                    .collect(Collectors.toList());
            resultJson.setScoreList(scoreList);

            if (item.getEvaluationType().equals("1")) {

                if (StringUtils.isNotEmpty(disease)){
                    disease = "此药适用的疾病";
                }

                // 具体打分
                String prompt1 = "作为药品临床综合评价专家，评价一下“"+drugInfo.getDrugName()+"”用于“"+disease+"”。请根据用户提供的评价条目名称和相应的评分规则，对每个条目进行评分。\n" +
                        "如果用户提供了相关信息（如药品数据、临床证据等），则优先使用该信息；如果未提供信息，则基于我的知识库检索相关证据（如药品说明书、医学文献、指南、临床试验或标准）。对于每个评价条目，输出应包括：\n" +
                        "评价结果（基于评分规则的描述性文本）\n" +
                        "得分（以阿拉伯数字表示，符合评分规则）\n" +
                        "注意：\n" +
                        "严格按照json返回；返回的结果包含两个字段，一个是content（评价结果详细内容）；一个是score（具体分值），但是要注意以下内容：\n" +
                        "（1）给出的评价结果中，需要给出基于这个评价条目以及相应的评分规则，你对于药品治疗/不治疗疾病的相关评价结果，也就是你为什么给出分值的原因；\n" +
                        "（2）你最终给出的得分不得超过评分规则的最高分，也不得低于评分规则的最低分；同时，不能出现不在评分规则内的分数。\n" +
                        "（3）若同一条目符合多条评分规则时，最终给我分值请采用就高原则。\n" +
                        "药品信息、疾病信息、评价条目、评分细则以及证据详情内容如下：\n" +
                        getDrugInfo(drugInfo,disease,item.getImportData(),resultJson.getTitle(),array.getJSONObject(i).getString("content"),scoreList) +
                        "’’’";

                HashMap<String, String> stringStringHashMap2 = new HashMap<>();
                stringStringHashMap2.put("content", "相关内容");
                stringStringHashMap2.put("score", "分数（单纯阿拉伯数字即可，如：5，不需要'多少分'）");
                JSONObject responseFormat1 = getResponseFormat(stringStringHashMap2);
              //  JSONObject jsonObject2 = lxGptService.executeGptPlus(prompt1, "分步打分", responseFormat1, "","");
                JSONObject jsonObject2 = gptAiUtils.executeGptPlusNoArray(prompt1, "分步打分",   "注意：严格按照json返回返回两个字段：1.content字段，本字段返回内容为我所提供资料跟打分相关的内容以及打分的理由；2.score字段，得分(一个阿拉伯数字即可）", "","");
                resultJson.setContent(jsonObject2.getString("content"));
                resultJson.setScore(Double.parseDouble(formatScore(jsonObject2.getString("score"))));
            } else {
                resultJson.setContent("");
                resultJson.setScore(0.0);
            }

            totalScore += resultJson.getScore();
            write(resultJson, response);
        }
        ResultJson resultJson = new ResultJson();
        resultJson.setTitle(item.getItemName());
        resultJson.setScore(totalScore);
        resultJson.setType("5");
        write(resultJson, response);
        return totalScore;

    }


    private void doWriteV2For(Vae.Item item, Vae.Dimension dimension,ArrayList<JSONObject> resultJsonList) {

        ResultJson resultJson1 = new ResultJson();
        resultJson1.setTitle(item.getItemName());
        resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
        resultJson1.setSuperiorTitle(dimension.getDimensionName());
        resultJson1.setType("4");
        JSONObject jsonObject1 = (JSONObject) JSON.toJSON(resultJson1);
       resultJsonList.add(jsonObject1);
        String prompt = VaeEnum.VAE_TOTAL_V2.getDefaultValue() +
                item.getDetailedRules() + "JSON返回，无需额外说明,注意：最高总分为" + item.getItemScore();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content", "拆分出来的打分细则,string返回");
        stringStringHashMap.put("score", "可能出现的分数,string返回，分值用英文逗号隔开");
        stringStringHashMap.put("maxScore", "此项最高总分,number返回");
        stringStringHashMap.put("title", "打分维度,string返回");
        JSONObject formatJson = new JSONObject();
        JSONArray jsonArray = new JSONArray();
        for (int i =1; i < 3; i++ ){
            JSONObject object = new JSONObject();
            object.put("content", "拆分出来的打分细则"+i+",string返回");
            object.put("score", "本条可能出现的分数string返回，分值用英文逗号隔开");
            object.put("maxScore", "本条的最大分值,string返回");
            object.put("title", "本条打分的维度");
            jsonArray.add(object);
        }
        formatJson.put("array", jsonArray);


        //生成缓存的key   md5处理prompt
         String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
        List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class,"evaluation_vae_cache");
        JSONObject jsonObject;
        if (CollUtil.isNotEmpty( list)){
            jsonObject = list.get(0).getJSONObject("info");
        }else {
             jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格以json格式返回，具体格式："+formatJson, "", "");
            if (StringUtils.isNotEmpty(jsonObject.getString("array"))) {
                JSONObject object = new JSONObject();
                object.put("info", jsonObject);
                object.put("time", new Date());
                object.put("prompt", prompt);
                object.put("key", key);
                mongoTemplate.insert(object, "evaluation_vae_cache");
            }
        }
        JSONArray array = jsonObject.getJSONArray("array");
        Double totalScore = 0.0;
        for (int i = 0; i < array.size(); i++) {
            ResultJson resultJson = new ResultJson();
            resultJson.setType("2");
            resultJson.setSuperiorTitle(resultJson1.getTitle());
            resultJson.setTitle(array.getJSONObject(i).getString("title"));
            resultJson.setMaxScore(array.getJSONObject(i).getDouble("maxScore"));
            String string = array.getJSONObject(i).getString("score");
            String[] split = string.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::parseDouble)
                    .collect(Collectors.toList());
            resultJson.setScoreList(scoreList);
            JSONObject jsonObject2 = (JSONObject) JSON.toJSON(resultJson);
           resultJsonList.add(jsonObject2);
        }
        ResultJson resultJson = new ResultJson();
        resultJson.setTitle(item.getItemName());
        resultJson.setScore(totalScore);
        resultJson.setType("5");
        JSONObject jsonObject3 = (JSONObject) JSON.toJSON(resultJson);
      resultJsonList.add(jsonObject3);


    }


    private Double doWrite(Vae.Item item, Vae.Dimension dimension, DrugInfoNew drugInfo, String disease, HttpServletResponse response) {
        if (item.getImportData().contains(InformationTypeEnum.GUIDE.getDescribe())) {
            ArrayList<String> drugs = new ArrayList<>();
            ArrayList<String> diseases = new ArrayList<>();
            try {

                if (StringUtils.isNotEmpty(drugInfo.getDrugZh())) {
                    lxGptService.GetSynonyms(drugInfo.getDrugZh(), drugs, disease, diseases);
                }else {
                    lxGptService. GetSynonyms(drugInfo.getDrugName(), drugs, disease, diseases);
                }
                List<String> list = gptCallUtil.splitDisease(disease);
                diseases.addAll(list);
            }catch (Exception e){
                log.error("disease split error:{}",e);
            }

            ResultJson resultJson1 = new ResultJson();
            resultJson1.setTitle(item.getItemName());
            resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
            resultJson1.setSuperiorTitle(dimension.getDimensionName());

            GuideAndScore guideAndScore  = guideSearch.vaePanel(drugInfo.getDrugName(), disease, drugs, diseases, item.getDetailedRules());
            List<GuideVO> guideVOS = guideAndScore.getGuideVOS();

            resultJson1.setScore(Double.valueOf(item.getItemScore()));
            resultJson1.setType("3");
            JSONArray objects = new JSONArray();
            if (CollUtil.isNotEmpty(guideVOS)){
                for ( GuideVO guideVO : guideVOS) {

                    JSONObject jsonObject1 = new JSONObject();
                    jsonObject1.put("title", guideVO.getTitle()+"-"+guideVO.getFbdate()+"-"+guideVO.getZdz());
                    jsonObject1.put("content", guideVO.getGuideInfo());
                    objects.add(jsonObject1);

                }
                resultJson1.setJsonContent(objects);
            } else {
                ResultJson resultJsonx = new ResultJson();
                resultJsonx.setTitle(item.getItemName());
                resultJsonx.setSuperiorTitle(dimension.getDimensionName());
                resultJsonx.setMaxScore(Double.valueOf(item.getItemScore()));
                String prompt = VaeEnum.VAE_TOTAL.getDefaultValue() + "一下是需要判断的内容：" +
                        item.getDetailedRules() + "注意：最高总分为" + item.getItemScore();

                HashMap<String, String> stringStringHashMap = new HashMap<>();
                stringStringHashMap.put("content", "拆分出来的打分细则");
                stringStringHashMap.put("score", "String类型,可能出现的分数，中间用英文逗号隔开");

                JSONObject formatJson = new JSONObject();
                stringStringHashMap.forEach((k, v) -> {
                    formatJson.put(k, v);
                });
                String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
                List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class, "evaluation_vae_cache");
                JSONObject jsonObject;
                if (CollUtil.isNotEmpty( list)){
                    jsonObject = list.get(0).getJSONObject("info");
                }else {
                    jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格按照json返回，返回格式请符合以下json"+formatJson, "", "");
                    if (ObjectUtil.isNotEmpty(jsonObject)){
                        JSONObject object = new JSONObject();
                        object.put("info", jsonObject);
                        object.put("time", new Date());
                        object.put("prompt", prompt);
                        object.put("key", key);
                        mongoTemplate.insert(object, "evaluation_vae_cache");
                    }
                }
                String score = jsonObject.getString("score");
                String[] split = score.split(",");
                List<Double> scoreList = Arrays.stream(split)
                        .map(Double::valueOf)
                        .collect(Collectors.toList());
                resultJsonx.setScoreList(scoreList);


                if (item.getEvaluationType().equals("1")) {
                    // 具体打分
                    String prompt1 = "作为药品临床综合评价专家，评价一下“"+drugInfo.getDrugName()+"”用于“"+disease+"”。请根据用户提供的评价条目名称和相应的评分规则，对每个条目进行评分。\n" +
                            "如果用户提供了相关信息（如药品数据、临床证据等），则优先使用该信息；如果未提供信息，则基于我的知识库检索相关证据（如药品说明书、医学文献、指南、临床试验或标准）。对于每个评价条目，输出应包括：\n" +
                            "评价结果（基于评分规则的描述性文本）\n" +
                            "得分（以阿拉伯数字表示，符合评分规则）\n" +
                            "注意：\n" +
                            "严格按照json返回；返回的结果包含两个字段，一个是content（评价结果详细内容）；一个是score（具体分值），但是要注意以下内容：\n" +
                            "（1）给出的评价结果中，需要给出基于这个评价条目以及相应的评分规则，你对于药品治疗/不治疗疾病的相关评价结果，也就是你为什么给出分值的原因；\n" +
                            "（2）你最终给出的得分不得超过评分规则的最高分，也不得低于评分规则的最低分；同时，不能出现不在评分规则内的分数。\n" +
                            "（3）若同一条目符合多条评分规则时，最终给我分值请采用就高原则。\n" +
                            "药品信息、疾病信息、评价条目、评分细则以及证据详情内容如下：\n" +
                            getDrugInfo(drugInfo,disease,item.getImportData(),resultJsonx.getTitle(),jsonObject.getString("content"),scoreList) +
                            "’’’";

                    HashMap<String, String> stringStringHashMap2 = new HashMap<>();
                    stringStringHashMap2.put("content", "相关内容");
                    stringStringHashMap2.put("score", "分数（单纯阿拉伯数字即可，如：5，不需要'多少分'）");
                    JSONObject responseFormat1 = getResponseFormat(stringStringHashMap2);
                    //  JSONObject jsonObject1 = lxGptService.executeGptPlus(prompt1, "分步打分", responseFormat1, "","");
                    JSONObject jsonObject1 = gptAiUtils.executeGptPlusNoArray(prompt1, "分步打分", "严格按照json返回返回两个字段：1.content字段，本字段返回内容为我所提供资料跟打分相关的内容以及打分的理由；2.score字段，得分", "","");
                    resultJsonx.setType("2");
                    resultJsonx.setContent(jsonObject1.getString("content"));
                    resultJsonx.setScore(Double.valueOf(formatScore(jsonObject1.getString("score"))));
                } else {
                    resultJsonx.setType("2");
                    resultJsonx.setContent("");
                    resultJsonx.setScore(0.0);

                }

                write(resultJsonx, response);
                return resultJsonx.getScore();
            }
            write(resultJson1, response);
            if(ObjectUtil.isNotEmpty(resultJson1.getScore())){
                return resultJson1.getScore();
            }else {
                return 0.0;
            }
        } else if (item.getImportData().contains(InformationTypeEnum.LITERATURE.getDescribe())){

            ResultJson resultJson1 = new ResultJson();
            resultJson1.setTitle(item.getItemName());
            resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
            resultJson1.setSuperiorTitle(dimension.getDimensionName());
            String prompt = VaeEnum.VAE_GUIDE.getDefaultValue() + "以下是需要判断的内容：" +
                    item.getDetailedRules() + "注意：最高总分为" + item.getItemScore();

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content", "拆分出来的打分细则");
            stringStringHashMap.put("score", "String类型,可能出现的分数，中间用英文逗号隔开");
            stringStringHashMap.put("keyword", "关键词");

            // JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject formatJson = new JSONObject();
            stringStringHashMap.forEach((k,v)->{
                formatJson.put(k,v);
            });
            String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
            List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class,"evaluation_vae_cache");
            JSONObject jsonObject;
            if (CollUtil.isNotEmpty( list)){
                jsonObject = list.get(0).getJSONObject("info");
            }else {
                jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格按照json返回，返回格式请符合以下json"+formatJson, "", "");
                if (ObjectUtil.isNotEmpty(jsonObject)) {
                    JSONObject object = new JSONObject();
                    object.put("info", jsonObject);
                    object.put("time", new Date());
                    object.put("prompt", prompt);
                    object.put("key", key);
                    mongoTemplate.insert(object, "evaluation_vae_cache");
                }
            }
            String score = jsonObject.getString("score");
            String[] split = score.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::valueOf)
                    .collect(Collectors.toList());
            resultJson1.setScoreList(scoreList);

            List<String> collect = null;
            String keyword = jsonObject.getString("keyword");
            if (StringUtils.isNotEmpty(keyword)) {
                String[] split1 = keyword.split(",");
                collect = Arrays.stream(split1)
                        .collect(Collectors.toList());
            }


            ArrayList<String> drugZh = new ArrayList<>();
            drugZh.add(drugInfo.getDrugName());
            drugZh.add(drugInfo.getDrugZh());
            if (StringUtils.isNotEmpty(disease)) {
                drugZh.add(disease);
            }
            StringBuilder stringBuilder = new StringBuilder();
            StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZh, "标题,摘要");
            stringBuilder1.append(" AND ");

            if (CollUtil.isNotEmpty(collect)) {
                stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, collect, "标题,摘要");
            }
            JSONObject jsonObjectx = new JSONObject();
            jsonObjectx.put("query", stringBuilder1.toString());
            jsonObjectx.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObjectx);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);

            BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
            boolQueryBuilder.must().add(wrapperQueryBuilder);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            if (literatureSearchHits.getTotalHits() > 0) {

                resultJson1.setScore(Double.valueOf(item.getItemScore()));
                resultJson1.setType("3");
                JSONArray objects = new JSONArray();
                int i = 0;
                for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                    Literature content = literatureSearchHit.getContent();
                    JSONObject jsonObject1 = new JSONObject();
                    jsonObject1.put("title", content.getTitle()+"-"+content.getYear()+"-"+content.getJournal());
                    jsonObject1.put("content", content.getSummary());
                    objects.add(jsonObject1);
                    i++;
                    if (i > 5) {
                        break;
                    }
                }
                resultJson1.setJsonContent(objects);
            } else {
                resultJson1.setType("2");
                resultJson1.setContent("暂无相关内容");
                resultJson1.setScore(0.0);
            }
            write(resultJson1, response);
            if(ObjectUtil.isNotEmpty(resultJson1.getScore())){
                return resultJson1.getScore();
            }else {
                return 0.0;
            }



        }else {
            ResultJson resultJson1 = new ResultJson();
            resultJson1.setTitle(item.getItemName());
            resultJson1.setSuperiorTitle(dimension.getDimensionName());
            resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
            String prompt = VaeEnum.VAE_TOTAL.getDefaultValue() + "一下是需要判断的内容：" +
                    item.getDetailedRules() + "注意：最高总分为" + item.getItemScore();

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content", "拆分出来的打分细则");
            stringStringHashMap.put("score", "String类型,可能出现的分数，中间用英文逗号隔开");

            JSONObject formatJson = new JSONObject();
            stringStringHashMap.forEach((k, v) -> {
                formatJson.put(k, v);
            });
             String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
            List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class, "evaluation_vae_cache");
            JSONObject jsonObject;
            if (CollUtil.isNotEmpty( list)){
                jsonObject = list.get(0).getJSONObject("info");
            }else {
                jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格按照json返回，返回格式请符合以下json"+formatJson, "", "");
                if (ObjectUtil.isNotEmpty(jsonObject)){
                    JSONObject object = new JSONObject();
                    object.put("info", jsonObject);
                    object.put("time", new Date());
                    object.put("prompt", prompt);
                    object.put("key", key);
                    mongoTemplate.insert(object, "evaluation_vae_cache");
                }
            }
            String score = jsonObject.getString("score");
            String[] split = score.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::valueOf)
                    .collect(Collectors.toList());
            resultJson1.setScoreList(scoreList);


            if (item.getEvaluationType().equals("1")) {
                // 具体打分
                String prompt1 = "作为药品临床综合评价专家，评价一下“"+drugInfo.getDrugName()+"”用于“"+disease+"”。请根据用户提供的评价条目名称和相应的评分规则，对每个条目进行评分。\n" +
                        "如果用户提供了相关信息（如药品数据、临床证据等），则优先使用该信息；如果未提供信息，则基于我的知识库检索相关证据（如药品说明书、医学文献、指南、临床试验或标准）。对于每个评价条目，输出应包括：\n" +
                        "评价结果（基于评分规则的描述性文本）\n" +
                        "得分（以阿拉伯数字表示，符合评分规则）\n" +
                        "注意：\n" +
                        "严格按照json返回；返回的结果包含两个字段，一个是content（评价结果详细内容）；一个是score（具体分值），但是要注意以下内容：\n" +
                        "（1）给出的评价结果中，需要给出基于这个评价条目以及相应的评分规则，你对于药品治疗/不治疗疾病的相关评价结果，也就是你为什么给出分值的原因；\n" +
                        "（2）你最终给出的得分不得超过评分规则的最高分，也不得低于评分规则的最低分；同时，不能出现不在评分规则内的分数。\n" +
                        "（3）若同一条目符合多条评分规则时，最终给我分值请采用就高原则。\n" +
                        "药品信息、疾病信息、评价条目、评分细则以及证据详情内容如下：\n" +
                        getDrugInfo(drugInfo,disease,item.getImportData(),resultJson1.getTitle(),jsonObject.getString("content"),scoreList) +
                        "’’’";

                HashMap<String, String> stringStringHashMap2 = new HashMap<>();
                stringStringHashMap2.put("content", "相关内容");
                stringStringHashMap2.put("score", "分数（单纯阿拉伯数字即可，如：5，不需要'多少分'）");
                JSONObject responseFormat1 = getResponseFormat(stringStringHashMap2);
              //  JSONObject jsonObject1 = lxGptService.executeGptPlus(prompt1, "分步打分", responseFormat1, "","");
                JSONObject jsonObject1 = gptAiUtils.executeGptPlusNoArray(prompt1, "分步打分", "严格按照json返回返回两个字段：1.content字段，本字段返回内容为我所提供资料跟打分相关的内容以及打分的理由；2.score字段，得分", "","");
                resultJson1.setType("2");
                resultJson1.setContent(jsonObject1.getString("content"));
                resultJson1.setScore(Double.valueOf(formatScore(jsonObject1.getString("score"))));
            } else {
                resultJson1.setType("2");
                resultJson1.setContent("");
                resultJson1.setScore(0.0);

            }

            write(resultJson1, response);
            return resultJson1.getScore();
        }

    }



    private String getDrugInfo(DrugInfoNew drugInfo,String disease,List<String> InEnum,String title,String content,List scoreList) {

        StringBuilder stringBuilder = new StringBuilder();

        stringBuilder.append("药品名称：" + drugInfo.getDrugName() + "\n");
        stringBuilder.append("所属企业:"+drugInfo.getManufacturer()+"\n");
        if (StringUtils.isNotEmpty(disease)) {
            stringBuilder.append("疾病名称：" + disease + "\n");
        }
        stringBuilder.append("评价条目"+title+"\n");
        stringBuilder.append("评分规则"+content+"\n");

        stringBuilder.append("打分请在以下分数中选择(0分有可能在此处不做例举，请自主判断)"+scoreList.toString()+"\n");


        if (CollUtil.isEmpty(InEnum)){
            stringBuilder.append("不提供相关内容，请你根据你所知材料判断");
        }


        for (String s : InEnum) {
            if (StringUtils.isEmpty(s)){
                continue;
            }
            String vaeInfo = VaeDrugInfoUtil.getVaeInfo(drugInfo, InformationTypeEnum.getInformationTypeEnum(s));
            stringBuilder.append(vaeInfo);
        }
        return stringBuilder.toString();
    }


    private void doWriteFor(Vae.Item item, Vae.Dimension dimension,ArrayList<JSONObject> resultJsonList) {
        if (item.getImportData().contains(InformationTypeEnum.GUIDE.getType())||item.getImportData().contains(InformationTypeEnum.LITERATURE.getType())) {
            ResultJson resultJson1 = new ResultJson();
            resultJson1.setTitle(item.getItemName());
            resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
            resultJson1.setSuperiorTitle(dimension.getDimensionName());
            String prompt = VaeEnum.VAE_GUIDE.getDefaultValue() + "以下是需要判断的内容：" +
                    item.getDetailedRules() + "注意：最高总分为" + item.getItemScore();

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content", "拆分出来的打分细则");
            stringStringHashMap.put("score", "String类型,可能出现的分数，中间用英文逗号隔开");
            stringStringHashMap.put("keyword", "关键词");

            // JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject formatJson = new JSONObject();
            stringStringHashMap.forEach((k,v)->{
                formatJson.put(k,v);
            });


            //生成缓存的key   md5处理prompt
            String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
            List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class, "evaluation_vae_cache");
            JSONObject jsonObject;
            if (CollUtil.isNotEmpty( list)){
                jsonObject = list.get(0).getJSONObject("info");
            }else {
                jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格按照json返回，返回格式请符合以下json"+formatJson, "", "");
                if (ObjectUtil.isNotEmpty(jsonObject)) {
                    JSONObject object = new JSONObject();
                    object.put("info", jsonObject);
                    object.put("time", new Date());
                    object.put("prompt", prompt);
                    object.put("key", key);
                    mongoTemplate.insert(object, "evaluation_vae_cache");
                }
            }

            String score = jsonObject.getString("score");
            String[] split = score.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::valueOf)
                    .collect(Collectors.toList());
            resultJson1.setScoreList(scoreList);
            resultJson1.setType("3");

            List<String> collect = null;
            String keyword = jsonObject.getString("keyword");
            if (StringUtils.isNotEmpty(keyword)) {
                String[] split1 = keyword.split(",");
                collect = Arrays.stream(split1)
                        .collect(Collectors.toList());
            }

            JSONObject jsonObject1 = (JSONObject) JSON.toJSON(resultJson1);
            resultJsonList.add(jsonObject1);

        } else {
            ResultJson resultJson1 = new ResultJson();
            resultJson1.setTitle(item.getItemName());
            resultJson1.setSuperiorTitle(dimension.getDimensionName());
            resultJson1.setMaxScore(Double.valueOf(item.getItemScore()));
            String prompt = VaeEnum.VAE_TOTAL.getDefaultValue() + "一下是需要判断的内容：" +
                    item.getDetailedRules() + "注意：最高总分为" + item.getItemScore();

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content", "拆分出来的打分细则");
            stringStringHashMap.put("score", "String类型,可能出现的分数，中间用英文逗号隔开");

            JSONObject formatJson = new JSONObject();
            stringStringHashMap.forEach((k, v) -> {
               formatJson.put(k, v);
           });

             String key = DigestUtils.md5DigestAsHex(item.toString().getBytes());
            List<JSONObject> list = mongoTemplate.find(new Query().addCriteria(Criteria.where("key").is(key)), JSONObject.class, "evaluation_vae_cache");
            JSONObject jsonObject;
            if (CollUtil.isNotEmpty( list)){
                jsonObject = list.get(0).getJSONObject("info");
            }else {
                jsonObject = gptAiUtils.executeGptPlus(prompt, "总的拆分", "请严格按照json返回，返回格式请符合以下json"+formatJson, "", "");
                if (ObjectUtil.isNotEmpty(jsonObject)){
                    JSONObject object = new JSONObject();
                    object.put("info", jsonObject);
                    object.put("time", new Date());
                    object.put("prompt", prompt);
                    object.put("key", key);
                    mongoTemplate.insert(object, "evaluation_vae_cache");
                }
            }

            String score = jsonObject.getString("score");
            String[] split = score.split(",");
            List<Double> scoreList = Arrays.stream(split)
                    .map(Double::valueOf)
                    .collect(Collectors.toList());
            resultJson1.setScoreList(scoreList);
            resultJson1.setType("2");

            JSONObject jsonObject1 = (JSONObject) JSON.toJSON(resultJson1);
          resultJsonList.add(jsonObject1);
        }

    }


    public void write(ResultJson value, HttpServletResponse response) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            JSONObject jsonObject = (JSONObject) JSON.toJSON(value);

            log.info("返回结果：{}",jsonObject);
            if (Objects.nonNull(value)) {
                // 需要data: 开头
                response.getWriter().write("data: " + jsonObject + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(1000);
        } catch (IOException | InterruptedException e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }




    @Async
    public void guidePanelFor(String scaleId) {

        mongoTemplate.remove(new Query(Criteria.where("scaleId").is(scaleId)), "evaluation_vae_guide_scale");
        Vae vae = mongoTemplate.findById(scaleId, Vae.class);

        List<Vae.Dimension> dimensions = vae.getDimensions();


        ArrayList<JSONObject> resultJsons = new ArrayList<>();


        for (Vae.Dimension dimension : dimensions) {
            ResultJson resultJson = new ResultJson();
            resultJson.setScore(null);
            resultJson.setType("1");
            dimension.setDimensionName(dimension.getDimensionName());
            resultJson.setTitle(dimension.getDimensionName());
            resultJson.setMaxScore(Double.valueOf(dimension.getDimensionScore()));
            // 一级标题书写
            JSONObject jsonObject = (JSONObject) JSON.toJSON(resultJson);
            resultJsons.add(jsonObject);

            List<Vae.Item> items = dimension.getItems();


            for (Vae.Item item : items) {

                if ("0".equals(item.getResultType())) {

                    // 只有二级的情况
                    item.setItemName(item.getItemName());
                     doWriteFor(item, dimension, resultJsons);
                } else {
                    // 有三级的情况    （多选的情况）
                    // 问题拆分
                    item.setItemName(item.getItemName());
                     doWriteV2For(item, dimension, resultJsons);
                }

            }

        }

        JSONObject object = new JSONObject();
        object.put("result", resultJsons);
        object.put("scaleId",scaleId);
        object.put("table", vae);
        mongoTemplate.save(object, "evaluation_vae_guide_scale");

    }


    public Object getPanelFor(String scaleId) {
        JSONObject templateOne = null;
        int maxAttempts = 200; // 最大尝试次数，防止无限循环
        int attempts = 0;

        while (templateOne == null && attempts < maxAttempts) {
            templateOne = mongoTemplate.findOne(
                    new Query(Criteria.where("scaleId").is(scaleId)),
                    JSONObject.class,
                    "evaluation_vae_guide_scale"
            );

            if (templateOne == null) {
                try {
                    Thread.sleep(5000); // 等待3秒后重试
                    attempts++;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        return templateOne;
    }



    @Override
    public String option1() {
        return "";
    }

    @Override
    public String option2() {
        return "";
    }

    @Override
    public String option3() {
        return "";
    }

    @Override
    public String option4() {
        return "";
    }

    @Override
    public String option5() {
        return "";
    }

    @Override
    public DataResult save(JSONObject jsonObject) {
        JSONObject evaluationVaeSave = mongoTemplate.save(jsonObject, "evaluation_vae_save");
        return DataResult.ok();
    }

    @Override
    public JSONObject getReport(String reportId) {
        JSONObject templateOne = mongoTemplate.findOne(new Query(Criteria.where("id").is(reportId)), JSONObject.class, "evaluation_vae_save");
        return templateOne;
    }


    private JSONObject getResponseFormat(Map<String, String> format) {
        JSONObject responseFormat = new JSONObject();
        JSONObject json_schema = new JSONObject();
        JSONObject schema = new JSONObject();
        JSONObject properties = new JSONObject();
        responseFormat.put("type", "json_schema");   // gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  // gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   // gpt未说明   固定
        json_schema.put("strict", true);  // 开启固定格式

        schema.put("additionalProperties", false);
        ArrayList<String> strings = new ArrayList<>();// 此对象包含的字段
        format.forEach((k, v) -> {                  // 组装此对象的所有字段
            JSONObject propertie = new JSONObject();
            propertie.put("type", "string");   // 这里默认认为字符串类型
            propertie.put("description", v);   // 此字段的描述
            properties.put(k, propertie);   // 此字段作为json的key，对应值为
            strings.add(k);
        });
        schema.put("properties", properties);
        schema.put("required", strings);  // 此对象包含的字段
        schema.put("type", "object");
        json_schema.put("schema", schema);
        return responseFormat;

    }


    // 组装array格式的schema方法
    private JSONObject getResponseFormatArray(Map<String, String> format) {
        JSONObject responseFormat = new JSONObject();
        JSONObject json_schema = new JSONObject();
        JSONObject schema = new JSONObject();
        JSONObject items = new JSONObject();
        schema.put("items", items);
        responseFormat.put("type", "json_schema");   // gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  // gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   // gpt未说明   固定
        json_schema.put("strict", true);  // 开启固定格式
        items.put("type", "object");
        JSONObject properties = new JSONObject();
        items.put("properties", properties);
        items.put("minItems", 1);
        items.put("maxItems", 10);
        ArrayList<String> strings = new ArrayList<>();
        format.forEach((k, v) -> {
            JSONObject value = new JSONObject();
            properties.put(k, value);

            if (v.contains("string")) {
                value.put("type", "string");
                value.put("description", v);
            } else if (v.contains("number")) {
                value.put("type", "number");
                value.put("description", v);
            } else if (v.contains("boolean")) {
                value.put("type", "boolean");
                value.put("description", v);
            }
            strings.add(k);


        });
        items.put("required", strings);
        items.put("additionalProperties", false);


        schema.put("type", "array");
        json_schema.put("schema", schema);
        return responseFormat;

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

    private String formatScore(String score) {
        //(1) 得分为整数的，直接显示分值，数值后不需要.00。如15;
        //(2) 得分为非整数的，请保留小数点后两位有效数字。
        double number = 0;
        try {
            number = Double.parseDouble(score);
        } catch (Exception e) {
            log.info("得分格式化异常{}", score);
            number = extractLastNumber(score);
            log.info("得分格式化异常纠正为{}", number);
        }

        if (number % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(number);
        } else {
            return new DecimalFormat("#.##").format(number);
        }
    }


    @Override
    public void download(String reportId, HttpServletResponse response) {


        JSONObject jsonObject = mongoTemplate.findOne(Query.query(Criteria.where("id").is(reportId)), JSONObject.class, "evaluation_vae_save");
        JSONObject jsonObject1 = jsonObject.getJSONObject("info");

        String scaleName = jsonObject1.getString("scaleName");
        VaeDownJson vaeDownJson = JSON.toJavaObject(jsonObject1, VaeDownJson.class);
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=" + vaeDownJson.getDrugNames() + "综合评价.doc");
        ServletOutputStream outputStream = null;
        try {
            outputStream = response.getOutputStream();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        Document document = new Document();
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        document.open();


        try {
            ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
            InputStream inputStreamImg = classPathResource.getInputStream();
            byte[] bytes = IOUtils.toByteArray(inputStreamImg);
            Image logo = Image.getInstance(bytes);
            logo.scaleAbsolute(100, 30);
            logo.setAlignment(Image.ALIGN_RIGHT);

            Paragraph headerParagraph = new Paragraph();
            headerParagraph.add(logo);
            headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

            HeaderFooter header = new HeaderFooter(headerParagraph, false);
            header.setAlignment(HeaderFooter.ALIGN_RIGHT);
            header.setBorderWidth(0);

            document.setHeader(header);
            Paragraph paragraphTitle = createDataWordV1(vaeDownJson.getDrugNames()+"综合评价报告");
            paragraphTitle.setAlignment(Element.ALIGN_CENTER);
            paragraphTitle.setSpacingBefore(190);
            paragraphTitle.setSpacingAfter(190);
            document.add(paragraphTitle);

            Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", Element.ALIGN_LEFT);
            headWord1.setAlignment(Element.ALIGN_CENTER);
            headWord1.setSpacingBefore(120);
            headWord1.setSpacingAfter(8);
            document.add(headWord1);

            Calendar calendar = Calendar.getInstance();
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);

            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);

            // 新开一页
            document.newPage();

            List<VaeContent> contentlist = vaeDownJson.getContentlist();
            String projectName = "";
            String projectNameAndScore= "";
            String project = "";
            Double totalScore = 0.0;
            for (VaeContent vaeContent : contentlist) {
                projectName += vaeContent.getTitle()+"、";
                projectNameAndScore += vaeContent.getTitle()+"("+vaeContent.getMaxScore()+")、";
                project += vaeContent.getTitle()+"最终得分为"+vaeContent.getScore()+"分，";
                totalScore += vaeContent.getMaxScore();
            }
            projectName = projectName.substring(0, projectName.length()-1);
            projectNameAndScore = projectNameAndScore.substring(0, projectNameAndScore.length()-1);
            project = project.substring(0, project.length()-1);

            String drugInfo =vaeDownJson.getDrugNames()+"-"+vaeDownJson.getSpecifications()+"-"+vaeDownJson.getManufacturers();
            // 摘要
            Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            document.add(abstractTitle);
            Paragraph abstractContent = new Paragraph("目的 根据《"+scaleName+"》对" + drugInfo + "进行临床综合评价。方法 该评价量表通过对"+projectNameAndScore+"等方面内容，对药品进行临床综合评价归纳总结。结果 " + drugInfo + "最终得分为" + vaeDownJson.getTotalScore() + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(abstractContent);

            // 评价目的
            Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
            // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(purposeTitle);



            Paragraph purposeContent = new Paragraph("本研究通过"+projectName+contentlist.size()+"个评价维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(purposeContent);

            // 评价药品
            Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(drugTitle);
            Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
            document.add(drugContent);

            // 评价过程
            Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(processTitle);
            Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《"+scaleName+"》进行量化打分，其评估维度包括"+projectName+"。总分加和为"+totalScore+"分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(processContent);

            // 评价结果
            Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(resultTitle);
            Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + vaeDownJson.getTotalScore() + "分，其中"+project+"。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(totalScoreParagraph);

            int x = 0;
            for (VaeContent vaeContent : contentlist) {
                x++;
                    Paragraph subSubItemTitle = createHeadSecondWord(x+"."+vaeContent.getTitle() + "（共" + doubleToString(vaeContent.getMaxScore()) +"分,得分："+doubleToString(vaeContent.getScore())+ "分）");
                    document.add(subSubItemTitle);
                    int y = 0;
                    for (VaeContent vaeContent1 : vaeContent.getChildren()) {
                        y++;
                        String title = x+"."+y+" "+vaeContent1.getTitle() + "（" + doubleToString(ObjectUtil.isNotEmpty(vaeContent1.getScore())?vaeContent1.getScore():0) + "分）";
                        Paragraph subSubItemTitle1 = createHeadSecondWord(title);
                        document.add(subSubItemTitle1);
                        if ("2".equals(vaeContent1.getType())){
                            Paragraph subSubItemContent = createDataWord(vaeContent1.getContent());
                            document.add(subSubItemContent);
                        }
                        if ("3".equals(vaeContent1.getType())){
                            JSONArray jsonContent = vaeContent1.getJsonContent();
                            int z = 0;
                            if (CollUtil.isNotEmpty(jsonContent)){
                                for (JSONObject o : jsonContent.toJavaList(JSONObject.class)) {
                                    z++;
                                    Paragraph subSubItemContent = createDataWord("("+z+") "+o.getString("title"));
                                    document.add(subSubItemContent);
                                    Paragraph subSubItemContent1 = createDataWord(o.getString("content"));
                                    document.add(subSubItemContent1);
                                }
                            }else {
                                Paragraph subSubItemContent = createDataWord("暂无相关内容");
                                document.add(subSubItemContent);
                            }

                        }

                        //存在三级
                        if (CollUtil.isNotEmpty(vaeContent1.getChildren())){
                            int z = 0;
                            for (VaeContent vaeContent2 : vaeContent1.getChildren()) {
                                z++;
                                String title3 = x+"."+y+"."+z+" "+vaeContent2.getTitle()+"（" + doubleToString(vaeContent2.getScore()) + "分）";
                                Paragraph dataWord = createDataWord(title3);
                                document.add(dataWord);
                                Paragraph contentWord = createDataWord(vaeContent2.getContent());
                                document.add(contentWord);

                            }
                        }


                    }

            }

            document.close();
        } catch (IOException e) {
            throw new RuntimeException(e);
        } catch (BadElementException e) {
            throw new RuntimeException(e);
        } catch (DocumentException e) {
            throw new RuntimeException(e);
        }
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

    //--------------------------------word样式设置----------------------------------------


    @Value("${evaluation.title.font.path}")
    private String TITLE_FONT_PATH;
    /**
     * 标题样式
     */
    private Paragraph createHeadWord(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWord(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private Paragraph createHeadSecondWord(String title) throws DocumentException, IOException {
        Font font = createFontWord(12, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    /**
     * 内容样式
     */
    public Paragraph createDataWord(String title) throws IOException, DocumentException {
        if (StringUtils.isEmpty(title)) {
            title = "暂无";
        }
        title = title.replaceAll("\\n$", "");
        Font font = createFontWord(12, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(5);
        paragraph.setSpacingAfter(5);
        return paragraph;
    }


    public Paragraph createDataWordV1(String title) throws IOException, DocumentException {
        if (StringUtils.isEmpty(title)) {
            title = "暂无";
        }
        title = title.replaceAll("\\n$", "");
        Font font = createFontWord(27, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(5);
        paragraph.setSpacingAfter(5);
        return paragraph;
    }

    private Font createFontWord(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }

    private Paragraph createHeadWordV1(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWordSongHui(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private Paragraph createHeadWordV2(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWordSong(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }


    private Font createFontWordSong(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, GRAY);
    }

    private Font createFontWordSongHui(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }





    public String extractContent(String key, Object value) {
        // 将key和value变为json格式的字符串
        if (value == null) {
            value = "暂无内容";
        }

        if (key.equals("guide")) {
            return "{\"" + key + "\":" + JSONObject.toJSON(value) + "}";
        }

        value = value.toString().replaceAll("\"", "'");
        String jsonString = "{\"" + key + "\":\"" + value + "\"}";
        return jsonString;
    }


    public void write(String key, Object value, HttpServletResponse response, String description) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            String s = extractContent(key, value);
            if (Objects.nonNull(s)) {
                s = s.replaceAll("\n", "\\\\n");
                // 需要data: 开头
                response.getWriter().write("data: " + s + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(1000);
        } catch (IOException | InterruptedException e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }



    private static int currentCol = 0; // 跟踪当前列索引
    private static final int BASIC_INFO_COL_COUNT = 7; // 基本信息列数：序号、日期、通用名、规格、厂家、单价、总分

    @Override
    public void exportToExcel(DrugEvaluation evaluation, HttpServletResponse response) throws IOException {
        if (evaluation == null || evaluation.getListInfo() == null || evaluation.getListInfo().isEmpty()) {
            throw new IllegalArgumentException("没有找到有效的评估数据");
        }

        // 创建Excel
        Workbook workbook = new XSSFWorkbook();
        Sheet sheet = workbook.createSheet("药品评估数据");

        // 创建表头样式
        CellStyle headerStyle = createHeaderStyle(workbook);
        int currentRow = addBasicInfoHeaders(sheet, headerStyle); // 创建表头行
        setRowHeights(sheet); // 设置行高

        CellStyle dataStyle = createDataStyle(workbook);

        // 处理所有药品数据
        List<ListInfo> allDrugs = evaluation.getListInfo();
        for (ListInfo drugInfo : allDrugs) {
            // 生成多级评分表头（只需要生成一次）
            if (currentRow == 3) {
                // 只有当有评分项时才生成评分表头
                if (drugInfo.getContentlist() != null && !drugInfo.getContentlist().isEmpty()) {
                    generateScoreHeaders(sheet, drugInfo.getContentlist(), headerStyle, currentRow);
                }
            }

            // 填充数据
            fillDataRow(sheet, drugInfo, currentRow, dataStyle);
            currentRow++;
        }

        // 调整列宽
        adjustColumnWidths(sheet);

        // 设置HTTP响应头，准备下载
        String fileName = "药品遴选_" +
                new SimpleDateFormat("yyyyMMdd").format(new Date()) + ".xlsx";

        // 处理中文文件名
        String encodedFileName = new String(fileName.getBytes("UTF-8"), "ISO-8859-1");

        // 设置响应头
        response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + encodedFileName + "\"");
        response.setHeader("Cache-Control", "no-cache");

        // 通过响应输出流写入Excel内容
        try (OutputStream os = response.getOutputStream()) {
            workbook.write(os);
            os.flush();
        } finally {
            workbook.close(); // 确保资源释放
        }
    }

    @Override
    public DrugEvaluation getDrugEvaluationData(String reportId) {


            String jsonString = getJsonData(reportId);
            ObjectMapper objectMapper = new ObjectMapper();
        try {
            //允许跳过空内容不报错
            objectMapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
            return objectMapper.readValue(jsonString, new TypeReference<DrugEvaluation>() {});
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        }

    }

    // 设置行高（需在表头行创建后调用）
    private static void setRowHeights(Sheet sheet) {
        // 表头行高（3行）
        for (int i = 0; i < 3; i++) {
            if (sheet.getRow(i) != null) {
                sheet.getRow(i).setHeightInPoints(25);
            }
        }
    }

    // 添加基本信息表头
    private static int addBasicInfoHeaders(Sheet sheet, CellStyle headerStyle) {
        int rowIndex = 0;
        // 创建3级表头行
        Row row0 = sheet.createRow(rowIndex++);
        Row row1 = sheet.createRow(rowIndex++);
        Row row2 = sheet.createRow(rowIndex++);

        // 基本信息列标题
        String[] basicInfoLabels = {"序号", "日期", "通用名", "规格", "厂家", "单价（元）", "总分"};

        for (int i = 0; i < basicInfoLabels.length; i++) {
            // 设置标题
            Cell cell0 = row0.createCell(i);
            cell0.setCellValue(basicInfoLabels[i]);
            cell0.setCellStyle(headerStyle);

            // 合并行0-2的当前列
            sheet.addMergedRegion(new CellRangeAddress(0, 2, i, i));

            // 行1和行2创建单元格并应用样式
            Cell cell1 = row1.createCell(i);
            cell1.setCellStyle(headerStyle);
            Cell cell2 = row2.createCell(i);
            cell2.setCellStyle(headerStyle);
        }
        return rowIndex;
    }

    // 生成评分项多级表头
    private static void generateScoreHeaders(Sheet sheet, List<ScoreItem> items, CellStyle headerStyle, int startRow) {
        currentCol = BASIC_INFO_COL_COUNT; // 从基本信息列后开始
        Row row0 = sheet.getRow(0); // 一级表头
        Row row1 = sheet.getRow(1); // 二级表头
        Row row2 = sheet.getRow(2); // 三级表头

        for (ScoreItem item : items) {
            int columnCount = countColumns(item); // 一级项总列数

            // 处理一级表头
            Cell cell0 = row0.createCell(currentCol);
            cell0.setCellValue(item.getTitle() + "(" + item.getMaxScore() + ")");
            cell0.setCellStyle(headerStyle);

            // 仅当列数大于1时才合并
            if (columnCount > 1) {
                sheet.addMergedRegion(new CellRangeAddress(0, 0, currentCol, currentCol + columnCount - 1));
            }

            // 处理二级表头
            if (item.getChildren() != null && !item.getChildren().isEmpty()) {
                int childStartCol = currentCol;
                for (ScoreItem child : item.getChildren()) {
                    int childColCount = countColumns(child);
                    String level2Text = child.getTitle() + "(" + child.getMaxScore() + ")";

                    // 设置二级表头
                    Cell cell1 = row1.createCell(childStartCol);
                    cell1.setCellValue(level2Text);
                    cell1.setCellStyle(headerStyle);

                    // 处理三级表头
                    if (child.getChildren() != null && !child.getChildren().isEmpty()) {
                        // 有三级
                        if (childColCount > 1) {
                            sheet.addMergedRegion(new CellRangeAddress(1, 1, childStartCol, childStartCol + childColCount - 1));
                        }
                        // 填充三级表头
                        int grandChildStartCol = childStartCol;
                        for (ScoreItem grandChild : child.getChildren()) {
                            Cell cell2 = row2.createCell(grandChildStartCol);
                            cell2.setCellValue(grandChild.getTitle() + "(" + grandChild.getMaxScore() + ")");
                            cell2.setCellStyle(headerStyle);
                            grandChildStartCol++;
                        }
                    } else {
                        // 无三级
                        sheet.addMergedRegion(new CellRangeAddress(1, 2, childStartCol, childStartCol + childColCount - 1));
                        Cell cell2 = row2.createCell(childStartCol);
                        cell2.setCellStyle(headerStyle);
                    }
                    childStartCol += childColCount;
                }
            } else {
                // 无二级
                Cell cell1 = row1.createCell(currentCol);
                cell1.setCellValue(item.getTitle());
                cell1.setCellStyle(headerStyle);
                sheet.addMergedRegion(new CellRangeAddress(1, 2, currentCol, currentCol + columnCount - 1));
                Cell cell2 = row2.createCell(currentCol);
                cell2.setCellStyle(headerStyle);
            }
            currentCol += columnCount;
        }
    }

    // 填充数据行
    private static void fillDataRow(Sheet sheet, ListInfo drugInfo, int startRow, CellStyle dataStyle) {
        Row dataRow = sheet.createRow(startRow);
        dataRow.setHeightInPoints(20); // 设置数据行行高
        int dataCol = 0;

        // 处理厂家名称
        String spec = drugInfo.getSpecification();
        String manufacturer = drugInfo.getManufacturers() != null ? drugInfo.getManufacturers() : "";


        // 基本信息数据
        String[] basicInfoValues = {
                String.valueOf(startRow - 2), // 序号（从1开始）
                new SimpleDateFormat("yyyy-MM-dd").format(new Date()), // 日期
                drugInfo.getDrugNames() != null ? drugInfo.getDrugNames() : "", // 通用名
                spec, // 规格
                manufacturer, // 厂家
                "", // 单价（需从数据源补充）
                String.valueOf(drugInfo.getTotalScore()) // 总分
        };

        // 填充基本信息
        for (String value : basicInfoValues) {
            Cell cell = dataRow.createCell(dataCol++);
            cell.setCellValue(value);
            cell.setCellStyle(dataStyle);
        }

        // 填充评分数据
        if (drugInfo.getContentlist() != null) {
            fillScoreData(dataRow, drugInfo.getContentlist(), dataCol, dataStyle);
        }
    }

    // 填充评分数据
    private static void fillScoreData(Row dataRow, List<ScoreItem> items, int startCol, CellStyle dataStyle) {
        int dataCol = startCol;
        for (ScoreItem item : items) {
            if (item.getChildren() != null) {
                for (ScoreItem child : item.getChildren()) {
                    if (child.getChildren() != null) {
                        for (ScoreItem grandChild : child.getChildren()) {
                            Cell cell = dataRow.createCell(dataCol);
                            cell.setCellValue(grandChild.getScore());
                            cell.setCellStyle(dataStyle);
                            dataCol++;
                        }
                    } else {
                        Cell cell = dataRow.createCell(dataCol);
                        cell.setCellValue(child.getScore());
                        cell.setCellStyle(dataStyle);
                        dataCol++;
                    }
                }
            } else {
                Cell cell = dataRow.createCell(dataCol);
                cell.setCellValue(item.getScore());
                cell.setCellStyle(dataStyle);
                dataCol++;
            }
        }
    }

    // 计算列数
    private static int countColumns(ScoreItem item) {
        if (item.getChildren() == null || item.getChildren().isEmpty()) {
            return 1;
        }
        int count = 0;
        for (ScoreItem child : item.getChildren()) {
            count += countColumns(child);
        }
        return count;
    }

    // 调整列宽
    private static void adjustColumnWidths(Sheet sheet) {
        // 基本信息列宽
        sheet.setColumnWidth(0, 8 * 256);  // 序号
        sheet.setColumnWidth(1, 12 * 256); // 日期
        sheet.setColumnWidth(2, 20 * 256); // 通用名
        sheet.setColumnWidth(3, 15 * 256); // 规格
        sheet.setColumnWidth(4, 30 * 256); // 厂家
        sheet.setColumnWidth(5, 12 * 256); // 单价
        sheet.setColumnWidth(6, 8 * 256);  // 总分

        // 评分项列宽
        for (int i = BASIC_INFO_COL_COUNT; i < currentCol; i++) {
            sheet.setColumnWidth(i, 18 * 256);
        }
    }

    // 创建表头样式
    private static CellStyle createHeaderStyle(Workbook workbook) {
        CellStyle style = workbook.createCellStyle();
        org.apache.poi.ss.usermodel.Font font = workbook.createFont();
        ((org.apache.poi.ss.usermodel.Font) font).setBold(true);
        style.setFont((org.apache.poi.ss.usermodel.Font) font);
        style.setAlignment(HorizontalAlignment.CENTER);
        style.setVerticalAlignment(VerticalAlignment.CENTER);
        style.setBorderTop(BorderStyle.THIN);
        style.setBorderBottom(BorderStyle.THIN);
        style.setBorderLeft(BorderStyle.THIN);
        style.setBorderRight(BorderStyle.THIN);
        style.setWrapText(true);
        return style;
    }

    // 创建数据样式
    private static CellStyle createDataStyle(Workbook workbook) {
        CellStyle style = workbook.createCellStyle();
        style.setAlignment(HorizontalAlignment.CENTER);
        style.setVerticalAlignment(VerticalAlignment.CENTER);
        style.setBorderTop(BorderStyle.THIN);
        style.setBorderBottom(BorderStyle.THIN);
        style.setBorderLeft(BorderStyle.THIN);
        style.setBorderRight(BorderStyle.THIN);
        return style;
    }


    private String getJsonData(String reportId) {
        List<JSONObject> jsonObjects = mongoTemplate.find(Query.query(Criteria.where("id").is(reportId)), JSONObject.class, "evaluation_vae_save");

        if (CollUtil.isNotEmpty(jsonObjects)){
            JSONObject jsonObject = jsonObjects.get(0);
            String string = jsonObject.getString("listId");
            List<JSONObject> jsonObjects1 = mongoTemplate.find(Query.query(Criteria.where("listId").is(string)), JSONObject.class, "evaluation_vae_score_list");
            return jsonObjects1.get(0).toJSONString();
        }

        return "";
    }




    // 获取JSON数据 - 实际应用中可从数据库或服务接口获取
    private static String getJsonData1() {
        return "{\n" +
                "    \"_id\": \"6879fc67d2b44719377c52ac\",\n" +
                "    \"listId\": \"3fd4e255-bc2e-4886-8726-944e8807f226\",\n" +
                "    \"listInfo\": [\n" +
                "        {\n" +
                "            \"drugNames\": \"乌帕替尼缓释片\",\n" +
                "            \"manufacturers\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG\",\n" +
                "            \"title\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG用于特应性皮炎\",\n" +
                "            \"contentlist\": [\n" +
                "                {\n" +
                "                    \"maxScore\": 28,\n" +
                "                    \"title\": \"药学特性\",\n" +
                "                    \"score\": 23.5,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"药理作用\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"体内过程\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"药剂学和使用方法（多选）\",\n" +
                "                            \"score\": 11,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"主要成分与辅料\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"规格与包装\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"剂型\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药剂量\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药频次\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"使用方便\",\n" +
                "                                    \"score\": 1\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 4,\n" +
                "                            \"title\": \"贮藏条件（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"贮藏条件\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"药品有效期\",\n" +
                "                            \"score\": 1.5\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 27,\n" +
                "                    \"title\": \"有效性\",\n" +
                "                    \"score\": 23,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"适应症\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 12\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 10,\n" +
                "                            \"title\": \"临床疗效\",\n" +
                "                            \"score\": 6\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 25,\n" +
                "                    \"title\": \"安全性\",\n" +
                "                    \"score\": 18,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 8,\n" +
                "                            \"title\": \"不良反应（多选）\",\n" +
                "                            \"score\": 5,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 5,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 5\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 9,\n" +
                "                            \"title\": \"特殊人群（可多选）\",\n" +
                "                            \"score\": 6,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"儿童\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"老人\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"妊娠期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"哺乳期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肝功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肾功能异常\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"药物相互作用所致不良反应\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"其他（可多选）\",\n" +
                "                            \"score\": 2,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 2\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"经济性\",\n" +
                "                    \"score\": 11,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"同通用名药品\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"主要适应证可替代药品\",\n" +
                "                            \"score\": 6\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"其他属性\",\n" +
                "                    \"score\": 9.6,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家医保\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家基本药物\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"国家集中采购药品\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"原研/参比/一致性评价\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"生产企业状况\",\n" +
                "                            \"score\": 0.6\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"全球使用情况\",\n" +
                "                            \"score\": 1\n" +
                "                        }\n" +
                "                    ]\n" +
                "                }\n" +
                "            ],\n" +
                "            \"totalScore\": 85.1,\n" +
                "            \"_class\": \"com.sentum.pojo.VaeDownJsonSimple\"\n" +
                "        },\n" +
                "        {\n" +
                "            \"drugNames\": \"乌帕替尼缓释片\",\n" +
                "            \"manufacturers\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG\",\n" +
                "            \"title\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG用于类风湿关节炎\",\n" +
                "            \"contentlist\": [\n" +
                "                {\n" +
                "                    \"maxScore\": 28,\n" +
                "                    \"title\": \"药学特性\",\n" +
                "                    \"score\": 26.5,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"药理作用\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"体内过程\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"药剂学和使用方法（多选）\",\n" +
                "                            \"score\": 11.5,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"主要成分与辅料\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"规格与包装\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"剂型\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药剂量\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药频次\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"使用方便\",\n" +
                "                                    \"score\": 1.5\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 4,\n" +
                "                            \"title\": \"贮藏条件（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"贮藏条件\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"药品有效期\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 27,\n" +
                "                    \"title\": \"有效性\",\n" +
                "                    \"score\": 27,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"适应症\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 12\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 10,\n" +
                "                            \"title\": \"临床疗效\",\n" +
                "                            \"score\": 10\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 25,\n" +
                "                    \"title\": \"安全性\",\n" +
                "                    \"score\": 14,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 8,\n" +
                "                            \"title\": \"不良反应（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 5,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 9,\n" +
                "                            \"title\": \"特殊人群（可多选）\",\n" +
                "                            \"score\": 4,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"儿童\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"老人\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"妊娠期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"哺乳期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肝功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肾功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"药物相互作用所致不良反应\",\n" +
                "                            \"score\": 2\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"其他（可多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"经济性\",\n" +
                "                    \"score\": 10,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"同通用名药品\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"主要适应证可替代药品\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"其他属性\",\n" +
                "                    \"score\": 9.8,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家医保\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家基本药物\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"国家集中采购药品\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"原研/参比/一致性评价\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"生产企业状况\",\n" +
                "                            \"score\": 0.8\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"全球使用情况\",\n" +
                "                            \"score\": 1\n" +
                "                        }\n" +
                "                    ]\n" +
                "                }\n" +
                "            ],\n" +
                "            \"totalScore\": 87.3,\n" +
                "            \"_class\": \"com.sentum.pojo.VaeDownJsonSimple\"\n" +
                "        }\n" +
                "    ]\n" +
                "}";
    }





}
