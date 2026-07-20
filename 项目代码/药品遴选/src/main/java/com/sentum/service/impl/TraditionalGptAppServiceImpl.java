package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.Retryer;
import com.sentum.constants.CommonConstants;
import com.sentum.enums.*;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.FormulaFeign;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.DrugContent;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.MongoLiterature;
import com.sentum.pojo.Patent;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.GuideSearch;
import com.sentum.service.TraditionalGptAppService;
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
public class TraditionalGptAppServiceImpl implements TraditionalGptAppService {

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
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    private GuideSearch guideSearch;


    @Autowired
    GptAiUtils gptAiUtils;


    public JSONObject getGptJson(String prompt,String name, String model,String score) {

        return gptAiUtils.executeGptPlus(prompt, name, GptDemoEnum.GPT_DEMO_1.getContent(), "", score);

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


    private void addProcessx(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(msg);
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    private void addProcessCache(String id, int step, String msg, List<String> stringBuilder, CacheNameEnum cacheName) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(cacheName.getName());
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    private boolean isEnglishOrDigit(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }

    private boolean isChineseCharacter(char c) {
        return c >= '\u4e00' && c <= '\u9fa5';
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

    private String formatInfo(String info) {
        if (ObjectUtil.isNotNull(info)) {
            int length = info.length();
            if (length > 50) {
                info = info.replaceAll("</br>", "");
                info = calculateScoreAndTruncate(info) + "...";
            }
        }
        return info;
    }

    private void addProcess(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        msg = formatInfo(msg);
        stringBuilder.add(msg);
        redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }

    public int getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrInheritanceEvaluationDto trInheritanceEvaluationDto) {
        String register = drugInfoNew.getRegister();
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("register").is(register)), JSONObject.class, "evaluation_tra_form");
        String recipeSource = "";
        String score = "";
        if (ObjectUtil.isNotEmpty(jsonObjects)) {
            recipeSource = "药品成分：" + jsonObjects.get(0).getString("component") + "\n" +
                    "组方来源：" + jsonObjects.get(0).getString("source") + "\n" +
                    (StringUtils.isNotEmpty(jsonObjects.get(0).getString("form")) ? "经方组成：" + jsonObjects.get(0).getString("form") + "\n" : "") +
                    (StringUtils.isNotEmpty(jsonObjects.get(0).getString("prop1")) ? jsonObjects.get(0).getString("prop1") : "") +
                    (StringUtils.isNotEmpty(jsonObjects.get(0).getString("prop2")) ? jsonObjects.get(0).getString("prop2") : "");
            score = jsonObjects.get(0).getString("score");
        }


        String recipeSourcePrompt =
                "你作为一名专业的中药研究研究员，" + (StringUtils.isNotEmpty(recipeSource) ? recipeSource : ((StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "药品成分：***" + drugInfoNew.getIngredient() + "***" : ""))) +
                        "分析一下" + drugInfoNew.getDrugName() + "的组方来源，请分析下这个药品的组方来源，是完全来源古代经典名方？还是在古代经典名方基础上化裁？还是由名老中医方或医院制剂转化？需要给出具体的原因说明。\n" + "请注意：（1）分析时需要分析药品的整体成分，而不是某一个单独成分。（2）若前三个都不是，则属于研制方\n" +
                        "并结合以下评分规则给出最终得分：（单选）\n" +
                        "完全来源古代经典名方：10分；\n" +
                        "古代经典名方基础上化裁：9分；\n" +
                        "老中医方或医院制剂转化：8分；\n" +
                        "研制方：7分；" +
                        "示例如下：\n" +
                        "（1）速效救心丸：【成分】川芎、冰片。其组方来源是：药学专家章臣桂教授的研制方；\n" +
                        "（2）复方丹参滴丸：【成分】丹参、三七、冰片。其组方来源是：华山医院与上海中药制药二厂研制方；\n" +
                        "（3）麝香保心丸：【成分】人工麝香、人参提取物、人工牛黄、肉桂、苏合香、蟾酥、冰片。其组方来源是：戴瑞鸿和上海中药一厂研制《太平惠民和剂局方》中的苏合香丸；\n" +
                        "（4）宽胸气雾剂：【成分】檀香油、荜茇油、高良姜油、细辛油、冰片。其组方来源是：陈可冀院士与郭士魁教授共同研制《古今医鉴》中的哭来笑去散。";


        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("content", "原因");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
      //  JSONObject recipeSourceResult = lxGptService.executeGptPlus(recipeSourcePrompt, "组方来源", responseFormat, "","10,9,8");
        JSONObject recipeSourceResult = getGptJson(recipeSourcePrompt, "组方来源",  "","10,9,8");

        String recipeSourceResultContent = recipeSourceResult.getString("content");
        if (StringUtils.isNotEmpty(recipeSource)) {
            recipeSourceResultContent = recipeSource;
        }

        trInheritanceEvaluationDto.setRecipeSourceContent(recipeSourceResultContent);
        String recipeSourceResultScore = recipeSourceResult.getString("score");
        trInheritanceEvaluationDto.setRecipeSourceScore(extractLastNumber(recipeSourceResultScore));

        if (StringUtils.isNotEmpty(score)) {
            recipeSourceResultScore = score;
            trInheritanceEvaluationDto.setRecipeSourceScore(extractLastNumber(recipeSourceResultScore));
        }

        addProcess(id, step++, "<p class='text_title'>基于河北省公立医疗机构中成药遴选评价表，对" + drugInfoNew.getDrugName() + "进行临床综合评价：</p>", stringBuilder);
        addProcessx(id, step++, "<b>1、传承评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>1.1 组方来源</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getRecipeSourceContent(), stringBuilder);

        if ("中成药".equals(drugInfoNew.getDrugCategory())) {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(2.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("基于中医药理论指导开发");
        } else {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(0.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("非中医药理论指导开发");
        }


        addProcessx(id, step++, "<b>1.2 理论支撑</b>", stringBuilder);
        addProcessx(id, step++, "<b>1.2.1 中医药理论指导</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getTheoryGuidanceContent(), stringBuilder);

        int ingredienttype = 3;
        //君臣佐使配伍
        //先判断成分性质

            String theorySupportPrompt1 =  "你作为一名专业的中药研究员，请根据提供的药品信息进行分析。首先需要判断药品主要成份的数量和类型：\n" +
                    "（1）如果药品成份中仅包含单一饮片名称（例如：黄连片的成份只有'黄连'），请返回数字1\n" +
                    "（2）如果药品成份中仅包含单一提取物名称（例如：七叶皂苷钠片的主要成份是'七叶皂苷'），请返回数字2\n" +
                    "（3）如果药品包含多个成份名称（例如：连花清瘟胶囊的成分有连翘､金银花､炙麻⻩､炒苦杏仁､石膏､板蓝根､绵⻢贯众､⻥腥草､广藿香､大⻩､红景天､薄荷脑､甘草），请返回数字3" +
                    "请注意：（1）当药品成份中明确提及“提取物”时，请返回数字2；（2）当药品成份中未明确提到“提取物”三个字，但是其成份名称也是提取物名称时，如三七总皂苷、人参果总皂苷、薯蓣总皂苷等，也请返回数字2；（3）当发现成份中含有提取物名称，且包含了提取物名称的主要成分以及辅料信息时，请直接忽略提取物名称的主要成分以及辅料信息，返回数字2即可。"
                    +
                    "注意：只返回数字，不返回其他内容\n" +
                    "药品信息:" + drugInfoNew.getDrugName() + "" +
                    (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "成分为" + drugInfoNew.getIngredient() : "");
            String gpt = lxGptService.getGpt(theorySupportPrompt1, "","");
            try {
                ingredienttype =Integer.parseInt(String.valueOf( extractLastNumber(gpt)));
            } catch (Exception e) {
                //正则提取其中的数字
                Pattern pattern = Pattern.compile("\\d+");
                Matcher matcher = pattern.matcher(gpt);
                if (matcher.find()) {
                    ingredienttype = Integer.parseInt(matcher.group());
                }
            }


        if (ingredienttype == 1 || ingredienttype == 2) {
            trInheritanceEvaluationDto.setTheoryCombinationScore(0.0);
            trInheritanceEvaluationDto.setTheoryCombinationContent("无法遵循中医药的君臣佐使配伍原则");
        } else {

            String theorySupportPrompt2 = "你作为一名专业的中药研究研究员，" + (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "请基于药品成份：***" + drugInfoNew.getIngredient() + "***" : "") +
                    " 分析一下" + drugInfoNew.getDrugName() + "请分析一下药品成分中的君药、臣药、佐药、使药分别是什么（若是没有，可以不进行叙述，但是不能乱说），发挥的作用是什么？";
            String gpt1 = lxGptService.getGpt(theorySupportPrompt2, "","");

            trInheritanceEvaluationDto.setTheoryCombinationScore(2.0);
            trInheritanceEvaluationDto.setTheoryCombinationContent(gpt1);

        }

        addProcessx(id, step++, "<b>1.2.2 君臣佐使配伍</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getTheoryCombinationContent(), stringBuilder);

        if (ingredienttype == 2) {
            trInheritanceEvaluationDto.setTheoryPathogenesisScore(0.0);
            trInheritanceEvaluationDto.setTheoryPathogenesisContent("君臣药的药性、归经与治疗目标不相符");

            trInheritanceEvaluationDto.setTheoryPotScore(0.0);
            trInheritanceEvaluationDto.setTheoryPotContent("君臣药的炮制品选择与治疗目标不相符");
        } else {
            trInheritanceEvaluationDto.setTheoryPathogenesisScore(1.0);
            trInheritanceEvaluationDto.setTheoryPathogenesisContent("君臣药的药性、归经与治疗目标相符");

            trInheritanceEvaluationDto.setTheoryPotScore(1.0);
            trInheritanceEvaluationDto.setTheoryPotContent("君臣药的炮制品选择与治疗目标相符");
        }


        addProcessx(id, step++, "<b>1.2.3 君臣药的药性、归经与治疗目标是否相符</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getTheoryPathogenesisContent(), stringBuilder);

        addProcessx(id, step++, "<b>1.2.4 君臣药的炮制品选择与治疗目标是否相符</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getTheoryPotContent(), stringBuilder);


        trInheritanceEvaluationDto.setTheorySupportScore();


        //病证结合
        String diseaseCombinationPrompt = " 你作为一名专业的中药药师，分析一下" + drugInfoNew.getDrugName() + "功能主治中疾病、证候、症状是否描述精确？" +
                "以下为说明书中功能主治原文：****" + drugInfoNew.getIndications() + "****" +
                "请结合以下评分规则，针对以上功能主治内容进行评分，并给出最终分值：（单选）" +
                "功能主治中疾病、证候、症状全部都有描述清楚：5分" +
                "功能主治中疾病或证候或症状：其中任何一项未阐述或者描述不清楚：3分" +
                "请注意：" +
                "（1）要根据实际数据进行评分，如果疾病、证候以及症状都有描述，就直接给5分；" +
                "（2）若疾病、证候、症状中任意一个没有描述，就给3分。";


      //  JSONObject diseaseCombination = lxGptService.executeGptPlus(diseaseCombinationPrompt, "病证结合", responseFormat, "","5,3");
        JSONObject diseaseCombination = getGptJson(diseaseCombinationPrompt, "病证结合", "","5,3");
        String diseaseCombinationContent = diseaseCombination.getString("content");
        String diseaseCombinationScore = diseaseCombination.getString("score");
        trInheritanceEvaluationDto.setDiseaseCombinationContent1(diseaseCombinationContent);
        trInheritanceEvaluationDto.setDiseaseCombinationScore1(extractLastNumber(diseaseCombinationScore));

        addProcessx(id, step++, "<b>1.3 病证结合</b>", stringBuilder);
        addProcessx(id, step++, "<b>1.3.1 疾病、证候、症状描述</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getDiseaseCombinationContent1(), stringBuilder);


        //西医描述
        String westMedicinePrompt = "你作为一名专业的中成药执业药师，非常了解中成药的功能主治中的疾病属于中医病还是西医病。请根据药品说明书中内容，分析一下" + drugInfoNew.getDrugName() + "的功能主治中针对疾病的描述是否采用了西医病描述疾病？\n" +
                "以下为说明书中功能主治原文：****" + (StringUtils.isNotEmpty(drugInfoNew.getIndications()) ?
                drugInfoNew.getIndications() : "说明书暂无描述") + "****\n" +
                "并结合以下评分规则进行评分，并给出最终分值：（单选）\n" +
                "疾病使用西医术语描述：1分;\n" +
                "疾病未使用西医术语描述：0分" +
                "请注意：" +
                "（1）如果功能主治中如没有使用西医术语表述疾病名称，给0分。\n" +
                "（2）只要任意一个疾病名称采用西医术语描述，就给1分。不用全部的疾病名称都采用西医术语描述才给1分。\n" +
                "（3）有“炎”“病”“综合征”“溃疡”“癌” 等时，属于西医病，如‘急性支气管炎’‘慢性胃炎’‘肝硬化’\n" +
                "（4）带有“急性、慢性、特发性、缺血性、感染性”等现代病理学修饰词时，属于西医病\n" +
                "（5）带有“器官/组织 +病理词”时，属于西医病：如冠心病、动脉粥样硬化、糖尿病、高血压、痔核、股骨头坏死等。\n" +
                "（6）如果一个疾病名称既在中医病范畴，又在西医病，请按照西医病算，如：手足藓、体癣、股癣、浸淫疮、内痔、外痔，给1分。\n" +
                "（7）可以根据以上我提供的相关注意事项（仅供参考），判断药品的功能主治中是否使用了西医术语描述疾病。请不要根据你自己的臆想胡乱判断疾病所属。\n";


       // JSONObject westMedicine = lxGptService.executeGptPlus(westMedicinePrompt, "西医描述", responseFormat, "gpt-4o-2024-08-06","1,0");
        JSONObject westMedicine = getGptJson(westMedicinePrompt, "西医描述", "gpt-4o-2024-08-06","1,0");
        String westMedicineContent = westMedicine.getString("content");
        String westMedicineScore = westMedicine.getString("score");
        trInheritanceEvaluationDto.setDiseaseCombinationContent2(westMedicineContent);
        trInheritanceEvaluationDto.setDiseaseCombinationScore2(extractLastNumber(westMedicineScore));

        addProcessx(id, step++, "<b>1.3.2 疾病使用西医术语描述</b>", stringBuilder);
        addProcess(id, step++, trInheritanceEvaluationDto.getDiseaseCombinationContent2(), stringBuilder);

        trInheritanceEvaluationDto.setDiseaseCombinationScore();


        trInheritanceEvaluationDto.setTotalScore();


        return step;

    }


    public int getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrClinicalEvaluationDto trClinicalEvaluationDto) {
        ArrayList<String> drugs = new ArrayList<>();
        drugs.add(drugInfoNew.getDrugName());
        drugs.addAll(drugInfoNew.getDrugSynonymZh());
        drugs.add(drugInfoNew.getDrugZh());
        StringBuilder stringBuilderc = new StringBuilder();
        StringBuilder stringBuildery = PromptUtil.montageForPaper(stringBuilderc, drugs, "标题");
        JSONObject jsonObjectx = new JSONObject();
        jsonObjectx.put("query", stringBuildery.toString());
        jsonObjectx.put("type", "2");
        String retrievalStr1 = formulaFeign.retrieval(jsonObjectx);
        WrapperQueryBuilder wrapperQueryBuilder1 = QueryBuilders.wrapperQuery(retrievalStr1);

        BoolQueryBuilder boolQueryBuilder5 = new BoolQueryBuilder();
        boolQueryBuilder5.must().add(wrapperQueryBuilder1);

        NativeSearchQuery nativeSearchQuery5 = new NativeSearchQuery(boolQueryBuilder5);
        SearchHits<GuideVO> literatureSearchHits5 = this.elasticsearchRestTemplate.search(nativeSearchQuery5, GuideVO.class);
        if (literatureSearchHits5.getTotalHits() > 0) {
            StringBuilder stringBuilder = new StringBuilder();
            ArrayList<GuideVO> guideVOS = new ArrayList<>();
            for (SearchHit<GuideVO> searchHit : literatureSearchHits5.getSearchHits()) {
                GuideVO content = searchHit.getContent();
                List<String> blocks = content.getBlocks();
                String blockx = "";
                for (String block : blocks) {
                    if (containsName(block, drugs) ) {
                        blockx += block;
                    }
                }
                if (blockx.length() > 0) {
                    content.setBlock(blockx);
                    guideVOS.add(content);
                }
                stringBuilder.append("标题："+content.getTitle()).append("\n");
                stringBuilder.append(blockx);
                if (guideVOS.size() > 5){
                    break;
                }
            }
            String prompt = "请根据我给出的指南标题判断" + drugInfoNew.getDrugName() + "是否是有治疗重大突发疾病，如新冠肺炎，若有返回相关信息，若无则返回'无'，返回'无'时请不要返回其他内容" +
                    "" + "，指南如下:\n" +
                    stringBuilder.toString();

            String gpt = lxGptService.getGpt(prompt, "", "");
            if ("无".equals(gpt)) {
                String  prompt1 ="你作为一名专业的中药药师，" + (StringUtils.isNotEmpty(drugInfoNew.getIndications())?drugInfoNew.getIndications():"") + "请基于药品说明书内容及其给定的指南信息：\n"+
                        "分析一下" + drugInfoNew.getDrugName() + "的在临床中定位是怎样的：" +
                        "药品可用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗：\n" +
                        "治疗相关疾病起到主要作用或缓解疾病过程中出现的各种不适症状：\n" +
                        "请注意：" +
                        "（1）结合说明书内容以及相关指南中该药品相关信息，若该药品曾经或者正在用于新发或突发传染病防治（如新冠肺炎），或者能够治疗罕见病或者属于儿童专科疾病的治疗药物，请给出分析原因，并给5分；" +
                        "（2）若结合说明书内容以及相关指南中该药品相关信息，该药品不能用于（1）时，请分析一下药品在以中医治疗为主的治疗方案中，属于主要治疗药品还是辅助用药？若说明书或指南中明确提及该药品是“辅助用药”，则给1分；若未明确提及“辅助用药”，则给3分。"+
                        "辅助用药是指在主要治疗（如手术、放疗、化疗、靶向治疗等）基础上，用于增强疗效、减轻副作用、改善患者耐受性或预防并发症的药物。这类药物不直接治疗疾病本身，但对主要治疗起到重要的支持作用（如化疗辅助止吐药）。"+
                        "给定的指南信息如下：\n" + stringBuilder;
                String gpt1 = lxGptService.getGpt(prompt1, "", "");
                trClinicalEvaluationDto.setClinicalPositioningContent(gpt1);
                trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("3"));
            } else {
                trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("5"));
                trClinicalEvaluationDto.setClinicalPositioningContent(gpt);
            }

        } else {


            String clinicalPositioningPrompt = "你作为一名专业的中药药师，" + (StringUtils.isNotEmpty(drugInfoNew.getIndications()) ? "请基于药品功能主治内容：***" + drugInfoNew.getIndications() : "") +
                    "分析一下" + drugInfoNew.getDrugName() + "的临床定位：" +
                    "请结合以下评分规则进行打分：（单选）\n" +
                    "药品可用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗：5分\n" +
                    "治疗相关疾病起到主要作用或缓解疾病过程中出现的各种不适症状：3分\n" +
                    "辅助主要治疗手段，对疾病恢复起到促进作用：1分\n" +
                    "请注意：" +
                    "（1）若药品曾经或者正在用于新发或突发传染病防治（如新冠肺炎），或者能够治疗罕见病或者属于儿童专科疾病的治疗药物，请给出分析原因，并给5分；" +
                    "（2）若药品不能用于（1）时，请分析一下药品在以中医治疗为主的治疗方案中，属于主要治疗药品还是辅助用药？辅助用药是指在主要治疗（如手术、放疗、化疗、靶向治疗等）基础上，用于增强疗效、减轻副作用、改善患者耐受性或预防并发症的药物。这类药物不直接治疗疾病本身，但对主要治疗起到重要的支持作用。（如化疗辅助止吐药）";

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
            stringStringHashMap.put("content", "分析过程");
            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
           // JSONObject clinicalPositioning = lxGptService.executeGptPlus(clinicalPositioningPrompt, "临床定位", responseFormat, "", "5,3,1");
            JSONObject clinicalPositioning = getGptJson(clinicalPositioningPrompt, "临床定位", "", "5,3,1");
            String clinicalPositioningContent = clinicalPositioning.getString("content");
            String clinicalPositioningScore = clinicalPositioning.getString("score");

            trClinicalEvaluationDto.setClinicalPositioningContent(clinicalPositioningContent);
            trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber(clinicalPositioningScore));
        }

        addProcessx(id, step++, "<b>2、临床评价</b>", stringBuilderx);
        addProcessx(id, step++, "<b>2.1 临床定位</b>", stringBuilderx);
        addProcess(id, step++, trClinicalEvaluationDto.getClinicalPositioningContent(), stringBuilderx);


        //临床研究


        String drugZh = drugInfoNew.getDrugZh();
        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugInfoNew.getDrugName());
        StringBuilder stringBuilder = new StringBuilder();
        StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题,摘要");
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

        if (literatureSearchHits.getTotalHits() > 0) {
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "(" + count + ")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(5.0);
        } else if (literatureSearchHits2.getTotalHits() > 0) {
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits2) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "(" + count + ")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(4.0);
        } else if (literatureSearchHits3.getTotalHits() > 0) {
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits3) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "(" + count + ")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(2.0);
        } else if (literatureSearchHits4.getTotalHits() > 0) {
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits4) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "(" + count + ")《" + title + "》\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(1.0);
        } else {
            trClinicalEvaluationDto.setClinicalResearchContent("未找到相关文献");
            trClinicalEvaluationDto.setClinicalResearchScore(0.0);
        }
        addProcessx(id, step++, "<b>2.2 临床研究</b>", stringBuilderx);
        addProcess(id, step++, trClinicalEvaluationDto.getClinicalResearchContent(), stringBuilderx);


        //证据推荐
        //证据推荐
        TrGuideVo TrguideVO =guideSearch.getGuideWithCache(drugZhs, drugInfoNew.getDrugZh());
        List<GuideVO> guideVOS = TrguideVO.getGuideVOList();
        if (guideVOS.size() > 0) {

            for (GuideVO guideVO : guideVOS) {
                TrClinicalEvaluationDto.EvidenceItem evidenceItem = new TrClinicalEvaluationDto.EvidenceItem("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate(), guideVO.getPdf_txt());
                trClinicalEvaluationDto.getEvidenceItems().add(evidenceItem);
            }
            trClinicalEvaluationDto.setEvidenceRecommendationScore(TrguideVO.getScore());
        }

//        addProcessx(id, step++, "<b>2.3 证据推荐</b>", stringBuilderx);
        List<TrClinicalEvaluationDto.EvidenceItem> evidenceItems = trClinicalEvaluationDto.getEvidenceItems();
//        if (CollUtil.isEmpty(evidenceItems)) {
//            addProcessx(id, step++, "未找到相关指南", stringBuilderx);
//        } else {
//            int x = 1;
//            for (TrClinicalEvaluationDto.EvidenceItem evidenceItem : evidenceItems) {
//                addProcessx(id, step++, x + ")" + evidenceItem.getTitle(), stringBuilderx);
//                addProcess(id, step++, evidenceItem.getContent(), stringBuilderx);
//                x++;
//            }
//        }

        addProcessx(id, step++, "<b>2.3 证据推荐</b>", stringBuilderx);

        if (CollUtil.isEmpty(evidenceItems)) {
            addProcessx(id, step++, "未找到相关指南", stringBuilderx);
        } else {
            int x = 1;
            for (TrClinicalEvaluationDto.EvidenceItem evidenceItem : evidenceItems) {
                addProcess(id, step++, evidenceItem.getTitle(), stringBuilderx);
                x++;
            }
        }

//        //临床需求
//        trClinicalEvaluationDto.setClinicalDemandOption("填补本院用药目录空白");
//        trClinicalEvaluationDto.setClinicalDemandScore(0.0);
//        trClinicalEvaluationDto.setTotalScore();


        addProcessx(id, step++, "<b>2.4 临床需求</b>", stringBuilderx);
        if (StringUtils.isNotEmpty(trClinicalEvaluationDto.getClinicalDemandOption())) {
            switch (trClinicalEvaluationDto.getClinicalDemandOption()) {
                case "1":
                    trClinicalEvaluationDto.setClinicalDemandOption("填补本院用药目录空白");
                    trClinicalEvaluationDto.setClinicalDemandScore(5.0);
                    break;
                case "2":
                    trClinicalEvaluationDto.setClinicalDemandOption("可推动本院中医优势病种发展或可纳入临床路径");
                    trClinicalEvaluationDto.setClinicalDemandScore(3.0);
                    break;
                case "3":
                    trClinicalEvaluationDto.setClinicalDemandOption("可为收治患者提供多种用药选择");
                    trClinicalEvaluationDto.setClinicalDemandScore(1.0);
                    break;
            }
        } else {
            trClinicalEvaluationDto.setClinicalDemandOption("暂无内容");
        }

        addProcessCache(id, step++, trClinicalEvaluationDto.getClinicalDemandOption(), stringBuilderx, CacheNameEnum.CACHE_Clinical);

        return step;


    }


    public TrGuideVo getGuideWithCache(List<String> drugZhs, String drugZh) {

        TrGuideVo trGuideVo = new TrGuideVo();
        ArrayList<GuideVO> guideVOS1 = new ArrayList<>();
        trGuideVo.setGuideVOList(guideVOS1);

        // 缓存中不存在数据，执行查询
        List<GuideVO> guideVOS = lxGptService.queryGuideByDrugAndDiseaseTr(drugZhs, drugZh, null, "");

        if (guideVOS != null) {
            String guideTitle = "";
            for (GuideVO guideVO : guideVOS) {
                guideTitle = guideTitle + "**********指南id:" + guideVO.getId() + "指南标题:" + guideVO.getTitle() + "**********";
            }


            String prompt = "请在我一下给的指南名称中给我找出最高分一等的指南，具体规则如下:" +
                    "顺序依次往下，等级越低：\n" +
                    "诊疗规范（关键词：诊疗规范、指导原则）：10分\n" +
                    "中成药治疗优势病种临床应用指南（关键词：指南标题中带有“中成药治疗”及“临床应用指南”字样）：10分（示例：中成药治疗痛经临床应用指南（2021年））\n" +
                    "由国家级学会组织发布的指南推荐（关键词：制定者中带有“学会”，同时还需要带有“国家”、“中国”、“中华”、“欧洲”、“美国”等代表国家的词，但是不能带有“专家共识”或者“共识”）：9分\n" +
                    "除了国家级学会的其他级别学会组织发布的指南（关键词：制定者中带有“学会”，同时不能带有“国家”、“中国”、“中华”、“欧洲”、“美国”等代表国家的词，也不能带有“专家共识”或者“共识”）：8分\n" +
                    "由国家级学会组织发布的专家共识推荐（关键词：制定者中带有“学会”，同时还需要带有“国家”、“中国”、“中华”、“欧洲”、“美国”等代表国家的词，同时还需要带有“专家共识”或者“共识”）：7分\n" +
                    "除了国家级学会的其他级别学会组织发布的专家共识（关键词：制定者中带有“专家共识”或者“共识”，同时不能带有“国家”、“中国”、“中华”、“欧洲”、“美国”等代表国家的词）：6分\n" +
                    "\n给出的指南如下：" + guideTitle + "" +
                    "$$$$$$$$$$$返回规则：返回两个字段：1.一个数字：最高的得分 2.String类型：符合最高得分等级的指南（取6篇，如果有多的按相关度取相关度最高的六篇关键词为:" + drugZh + "）," +
                    "返回它们的id,id拼接为一个字符串，id中间用英文','隔开";
            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("score", "一个数字：最高的得分");
            stringStringHashMap.put("ids", "String类型：符合最高得分等级的指南（取6篇，如果有多的按相关度取相关度最高的六篇关键词为:" + drugZh + "）,返回它们的id,id拼接为一个字符串，id中间用英文','隔开");
            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject jsonObject = lxGptService.executeGptPlus(prompt, "指南", responseFormat, "","10,9,8,7,6");
            String ids = jsonObject.getString("ids");
            String[] id = ids.split(",");

            String score = jsonObject.getString("score");
            trGuideVo.setScore(extractLastNumber(score));

            //转为list
            List<String> idList = Arrays.asList(id);

            String guides = "";

            HashMap<String, String> stringStringHashMap2 = new HashMap<>();
            for (GuideVO guideVO : guideVOS) {
                if (idList.contains(guideVO.getId())) {
                    guides = guides + "************指南id:" + guideVO.getId() + "指南标题:" + guideVO.getTitle() + "指南节选:" + guideVO.getPdf_txt() + "**********";
                    stringStringHashMap2.put(guideVO.getId(), "指南id为" + guideVO.getId() + "的指南总结的内容（原文什么语言则返回什么语言）");
                }
            }

            String prompt2 = " 我现在正在研究" + drugZh + "的指南，请把下列指南每篇给我总结一段话，关于" + drugZh + "指南如下:"
                    + guides + "json返回,返回的字段名就是对应id，值为总结(返回的内容务必提及"+drugZh+")";
            JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
            JSONObject jsonObject2 = lxGptService.executeGptPlus(prompt2, "指南总结", responseFormat2, "","");

            for (GuideVO guideVO : guideVOS) {
                if (idList.contains(guideVO.getId())) {
                    if (jsonObject2.containsKey(guideVO.getId())) {
                        guideVO.setPdf_txt(jsonObject2.getString(guideVO.getId()));
                        guideVOS1.add(guideVO);
                    }
                }
            }


        }

        return trGuideVo;
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
    public int getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew, String idx, List<String> stringBuilderx, int step, TrSafetyEvaluationDto trSafetyEvaluationDto) {
        //不良反应描述
        // String adverseReactionPrompt = "你作为一名专业的中药药师，需要根据" + drugInfoNew.getDrugName()  + "说明书中【不良反应】以及【禁忌】原文信息，" +
        //         "分析一下说明书中【不良反应】以及【禁忌】两个模块的原文描述中，是否存在“尚不明确”等模糊字眼；或者直接显示为“无”。" +
        //         "并结合以下评分规则进行评分（单选）：" +
        //         "2分：不良反应、禁忌均描述清晰，不含“尚不明确”等模糊字眼"+
        // "0分：不良反应、禁忌：其中一个或者两个描述不清晰，含有“尚不明确”等模糊字眼；或者直接显示为“无”。" +
        //         "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
        //         "【不良反应】：" + drugInfoNew.getAdverseReaction() + "\n" +
        //         "【禁忌】：" + drugInfoNew.getContraindications();
        String gpt;
        // String gpt = lxGptService.getGpt(adverseReactionPrompt, "","2,0");
        if (StringUtils.isEmpty(drugInfoNew.getAdverseReaction())){
            drugInfoNew.setAdverseReaction("");
        }
        if (StringUtils.isEmpty(drugInfoNew.getContraindications())){
            drugInfoNew.setContraindications("");
        }

        if (drugInfoNew.getAdverseReaction().contains("尚不明确") || drugInfoNew.getContraindications().contains("尚不明确") || "无".equals(drugInfoNew.getAdverseReaction()) || "无".equals(drugInfoNew.getContraindications())||
                "无。".equals(drugInfoNew.getAdverseReaction())|| "无。".equals(drugInfoNew.getContraindications())) {
            gpt = "0";
        } else {
            gpt = "2";
        }
        trSafetyEvaluationDto.setAdverseReactionScore(extractLastNumber(gpt));
        String content = "";
        if (StringUtils.isNotEmpty(drugInfoNew.getAdverseReaction())) {
            drugInfoNew.setAdverseReaction(drugInfoNew.getAdverseReaction().replaceAll("\\n", ""));
            content += "【不良反应】" + drugInfoNew.getAdverseReaction();
        }
        if (StringUtils.isNotEmpty(drugInfoNew.getContraindications())) {
            drugInfoNew.setContraindications(drugInfoNew.getContraindications().replaceAll("\\n", ""));
            content += "\n" + "【禁忌】" + drugInfoNew.getContraindications();
        }
        if (StringUtils.isEmpty(content)) {
            content = "说明书中无【不良反应】与【禁忌】相关内容。";
        }
        trSafetyEvaluationDto.setAdverseReactionContent(content);
        if (content.contains("尚不明确")) {
            trSafetyEvaluationDto.setAdverseReactionScore(0.0);
        }


        // 安全评价
        addProcessx(idx, step++, "<b>3、安全评价</b>", stringBuilderx);
        addProcessx(idx, step++, "<b>3.1 安全信息评价</b>", stringBuilderx);
        addProcessx(idx, step++, "<b>3.1.1 不良反应、禁忌等描述</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getAdverseReactionContent(), stringBuilderx);


        //警告提示
        String warningNotePrompt = "你作为一名专业的中药药师，根据" + drugInfoNew.getDrugName() + "说明书中以下警示语以及注意事项原文信息，" +
                "【警告提示】：" + drugInfoNew.getDrugWarning() + "\n" +
                "【注意事项】：" + drugInfoNew.getNotes() +
                "分析一下两个模块中任意一个模块中，是否有可以提示用户某种情况下可以避免或者减轻药物不良反应的相关内容，若是，给2分；若没有提及，给0分。" +
                "返回一个具体得分（只要阿拉伯数字）";
        String gpt1 = lxGptService.getGpt(warningNotePrompt, "","2,0");


        if (StringUtils.isNotEmpty(drugInfoNew.getDrugWarning()) && StringUtils.isNotEmpty(drugInfoNew.getNotes())) {

            trSafetyEvaluationDto.setWarningNoteContent("【警告语】：" + drugInfoNew.getDrugWarning() + "\n" +
                    "【注意事项】：" + drugInfoNew.getNotes());
        } else if (StringUtils.isNotEmpty(drugInfoNew.getNotes())) {
            trSafetyEvaluationDto.setWarningNoteContent("【警告语】：无" + "\n" +
                    "【注意事项】：" + drugInfoNew.getNotes());
        } else if (StringUtils.isNotEmpty(drugInfoNew.getDrugWarning())) {
            trSafetyEvaluationDto.setWarningNoteContent("【警告语】：" + drugInfoNew.getDrugWarning() + "\n" +
                    "【注意事项】：无");
        } else {
            trSafetyEvaluationDto.setWarningNoteScore(0.0);
            trSafetyEvaluationDto.setWarningNoteContent("无相关警示或者注意事项");
        }

        trSafetyEvaluationDto.setWarningNoteScore(extractLastNumber(gpt1));


        addProcessx(idx, step++, "<b>3.1.2 说明书中警示语或注意事项</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getWarningNoteContent(), stringBuilderx);


        //辅料
        if (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) && drugInfoNew.getIngredient().contains("辅料")) {
            trSafetyEvaluationDto.setExcipientScore(1.0);
            trSafetyEvaluationDto.setExcipient(drugInfoNew.getIngredient());
        } else {
            trSafetyEvaluationDto.setExcipientScore(0.0);
            trSafetyEvaluationDto.setExcipient("说明书无辅料相关内容");
        }
        addProcessx(idx, step++, "<b>3.1.3 辅料</b>", stringBuilderx);
        addProcess(idx, step++, String.valueOf(trSafetyEvaluationDto.getExcipient()), stringBuilderx);

        //安全性再评价
        ArrayList<String> drugZhs = new ArrayList<>();
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
        if (literatureSearchHits.getTotalHits() > 0) {
            String string = "";
            boolean flag = false;
            boolean ismetaAndFlags = false;
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {

                String title = literatureSearchHit.getContent().getTitle();
                String id = literatureSearchHit.getContent().getId();
                MongoLiterature paper = fineScreenFeign.paper(id);
                string += "(" + count + ")《" + title + "》\n";
                if (StringUtils.isNotEmpty(paper.getMethod())) {
                    string += "研究方法：" + paper.getMethod() + "\n";
                } else {
                    string += "摘要：" + literatureSearchHit.getContent().getSummary() + "\n";
                }
                count++;
            }
            String quear = "请根据我提供的文献摘要内容，并结合以下评分规则进行打分（单选，分值采用就高原则）\n" +
                    "1、多中心集中监测：3分；\n" +
                    "2、单中心集中监测：2分；\n" +
                    "3、基于不良反应的系统评价：1分。\n" +
                    "请注意：\n" +
                    "（1）多中心的定义：指多个研究机构（如医院、大学、实验室等）共同参与完成的研究。\n" +
                    "（2）单中心的定义：指由一个研究机构（如一家医院、大学、实验室等）独立设计、实施和研究的临床研究。\n" +
                    "提供的文献信息如下：\n" +
                    "’’’" +
                    string +
                    "’’’\n" +
                    "文献分别评分，返回一个最高得分文献的得分(阿拉伯数字)";

            String score = lxGptService.getGpt(quear, "", "3,2,1");
            trSafetyEvaluationDto.setSafetyReevaluationContent(string);
            trSafetyEvaluationDto.setSafetyReevaluationScore(extractLastNumber(score));
        } else {
            trSafetyEvaluationDto.setSafetyReevaluationScore(0.0);
            trSafetyEvaluationDto.setSafetyReevaluationContent("未找到安全性相关内容");
        }


        addProcessx(idx, step++, "<b>3.1.4 安全性再评价</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getSafetyReevaluationContent(), stringBuilderx);


        //人群限制
        //儿童
        String childPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "请抽提出以上原文信息中所有与儿童用药相关内容，总结出药品是否可用于全部儿童或者某一年龄段的儿童，并结合以下评分规则给出最终得分：\n" +
                "3岁以下儿童可用：2分\n" +
                "3~5岁儿童可用：1.5分\n" +
                "6~10岁儿童可用：1分\n" +
                "11-16岁儿童可用：0.5分\n" +
                "所有儿童可用：2分\n" +
                "请注意：\n" +
                "（1）只要说明书中未明确提及儿童时，认为尚不明确，给0分；\n" +
                "（2）当出现“在医生指导下使用”时，算作可用，给2分；\n" +
                "（3）当给出的内容中没有明确儿童的具体年龄时，将其认为是所有儿童。\n" +
                "（4）儿童用药情况尚无证据时，给0分。" +
                "（5）给出的关于儿童用药的相关内容描述，不要出现英文。";
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content", "挑选出的关于儿童用药的相关内容");
        stringStringHashMap.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        //JSONObject jsonObject1 = lxGptService.executeGptPlus(childPrompt, "child", responseFormat, "gpt-4o-2024-08-06","2,1.5,1,0.5,0");
        JSONObject jsonObject1 = getGptJson(childPrompt, "child", "gpt-4o-2024-08-06","2,1.5,1,0.5,0");
        trSafetyEvaluationDto.setPediatricDrugUseScore(extractLastNumber(jsonObject1.getString("score")));
        trSafetyEvaluationDto.setPediatricDrugUseContent(jsonObject1.getString("content"));


        addProcessx(idx, step++, "<b>3.2 人群限制</b>", stringBuilderx);
        addProcessx(idx, step++, "<b>3.2.1 儿童用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getPediatricDrugUseContent(), stringBuilderx);


        //妊振期妇女
        String pregnancyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "请抽提出以上原文信息中所有与妊娠期妇女用药相关内容，总结出妊娠期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "妊娠期妇女可用；1分\n" +
                "妊娠期妇女慎用：0.5分\n" +
                "妊娠期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（3）没有明确妊娠期妇女相关信息时，认为是尚不明确。\n";
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content", "挑选出的关于孕妇及哺乳期妇女用药的相关内容");
        stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
      //  JSONObject jsonObject2 = lxGptService.executeGptPlus(pregnancyPrompt, "pregnancy", responseFormat1, "","1,0.5,0");
        JSONObject jsonObject2 = getGptJson(pregnancyPrompt, "pregnancy", "","1,0.5,0");
        trSafetyEvaluationDto.setPregnancyDrugUseScore(extractLastNumber(jsonObject2.getString("score")));
        trSafetyEvaluationDto.setPregnancyDrugUseContent(jsonObject2.getString("content"));

        addProcessx(idx, step++, "<b>3.2.2 妊娠期妇女用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getPregnancyDrugUseContent(), stringBuilderx);


        //哺乳期妇女
        String lactationPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "请抽提出以上原文信息中所有与哺乳期妇女用药相关内容，总结出哺乳期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "哺乳期妇女可用；1分\n" +
                "哺乳期妇女慎用：0.5分\n" +
                "哺乳期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（3）没有明确哺乳期妇女相关信息时，认为是尚不明确。\n";
        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content", "挑选出的关于哺乳期妇女用药的相关内容");
        stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
        // JSONObject jsonObject3 = lxGptService.executeGptPlus(lactationPrompt, "lactation", responseFormat2, "","1,0.5,0");
        JSONObject jsonObject3 = getGptJson(lactationPrompt, "lactation", "","1,0.5,0");
        trSafetyEvaluationDto.setLactationDrugUseScore(extractLastNumber(jsonObject3.getString("score")));
        trSafetyEvaluationDto.setLactationDrugUseContent(jsonObject3.getString("content"));


        addProcessx(idx, step++, "<b>3.2.3 哺乳期妇女用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getLactationDrugUseContent(), stringBuilderx);


        if (!drugInfoNew.toString().contains("肝")) {
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent("尚不明确");
        } else {
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
           // JSONObject jsonObject4 = lxGptService.executeGptPlus(liverPrompt, "liver", responseFormat3, "","1,0.5,0");
            JSONObject jsonObject4 = getGptJson(liverPrompt, "liver", "","1,0.5,0");
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(extractLastNumber(jsonObject4.getString("score")));
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent(jsonObject4.getString("content"));
        }


        addProcessx(idx, step++, "<b>3.2.4 肝功能异常者用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getLiverDysfunctionDrugUseContent(), stringBuilderx);

        if (!drugInfoNew.toString().contains("肾")) {
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent("尚不明确");
        } else {

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
            //JSONObject jsonObject5 = lxGptService.executeGptPlus(kidneyPrompt, "kidney", responseFormat4, "","1,0.5,0");
            JSONObject jsonObject5 = getGptJson(kidneyPrompt, "kidney", "","1,0.5,0");
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(extractLastNumber(jsonObject5.getString("score")));
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent(jsonObject5.getString("content"));
        }
        addProcessx(idx, step++, "<b>3.2.5 肾功能异常者用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getKidneyDysfunctionDrugUseContent(), stringBuilderx);


        if (!drugInfoNew.toString().contains("运动员")) {
            trSafetyEvaluationDto.setAthleteDrugUseScore(1.0);
            trSafetyEvaluationDto.setAthleteDrugUseContent("未明确提及运动员相关信息，认为运动员可用");
        } else {
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
           // JSONObject jsonObject6 = lxGptService.executeGptPlus(athletePrompt, "athlete", responseFormat5, "","1,0");
            JSONObject jsonObject6 = getGptJson(athletePrompt, "athlete", "","1,0");
            trSafetyEvaluationDto.setAthleteDrugUseScore(extractLastNumber(jsonObject6.getString("score")));
            trSafetyEvaluationDto.setAthleteDrugUseContent(jsonObject6.getString("content"));
        }
        trSafetyEvaluationDto.setSafetyInfoScore();
        addProcessx(idx, step++, "<b>3.2.6 运动员用药</b>", stringBuilderx);
        addProcess(idx, step++, trSafetyEvaluationDto.getAthleteDrugUseContent(), stringBuilderx);


        //不良反应分级
        String adverPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****【不良反应】：" + drugInfoNew.getAdverseReaction() +
                "【注意事项】：" + drugInfoNew.getNotes() + "*****，" +
                "请基于以上内容，分析一下药品不良反应症状如何，并结合以下评分规则给出最终得分（单选）：\n" +
                "不良反应症状轻微，无需治疗或改变给药方案：5分\n" +
                "不良反应症状明显，需要干预治疗或改变给药方案：3分\n" +
                "不良反应症状严重，需立刻采取解救手段且改变给药方案：1分\n";
        HashMap<String, String> stringStringHashMap6 = new HashMap<>();
        stringStringHashMap6.put("content", "判断发生不良反应后，是否需要改变给药方案");
        stringStringHashMap6.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat6 = getResponseFormat(stringStringHashMap6);
       // JSONObject jsonObject7 = lxGptService.executeGptPlus(adverPrompt, "adver", responseFormat6, "","5,3,1");
        JSONObject jsonObject7 = getGptJson(adverPrompt, "adver", "","5,3,1");
        trSafetyEvaluationDto.setAdverseReactionStratificationScore(extractLastNumber(jsonObject7.getString("score")));
        trSafetyEvaluationDto.setAdverseReactionStratificationContent(jsonObject7.getString("content"));
        trSafetyEvaluationDto.setCrowdRestrictionScore();
        trSafetyEvaluationDto.setTotalScore();


        addProcessx(idx, step++, "<b>3.3 不良反应分级</b>", stringBuilderx);
        addProcessx(idx, step++, trSafetyEvaluationDto.getAdverseReactionStratificationContent(), stringBuilderx);

        return step;

    }


    //技术评价
    public int getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrTechnologyEvaluationDto trTechnologyEvaluationDto) {

        //频次
        String prompt ="你作为一名专业的中成药执业药师，非常了解中成药相关用法用量，特别是中成药的给药频次。"+
                " 药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getUsageAndDosage() + "*****，" +
                "请帮我摘取药品给药频次相关的内容，如果没有相关的则返回说明书未明确给药频次相关内容\n" +
                "并结合以下评分规则进行评分，并给出最终分值：（单选）\n" +
                "每日1次：2分;" +
                "每日2次：1.5分;" +
                "每日3次：1分;" +
                "每日4次：0分;" +
                "超过每日4次：0分" +
                "请注意：" +
                "（1）如果用法用量中存在多种给药频次时，评分结果请采用就低原则。如：轻症每日一次，重症早晚各一次。这种情况按每日2次的规则来给分。\n" +
                "（2）当用法用量中没有明确给药次数时，给0分。如：“每日数次。”或者“根据症状适当增减。”\n" ;
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content", "药品用药频次相关的内容");
        stringStringHashMap.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
       // JSONObject jsonObject = lxGptService.executeGptPlus(prompt, "frequency", responseFormat, "","2,1.5,1,0");
        JSONObject jsonObject = getGptJson(prompt, "frequency", "","2,1.5,1,0");
        trTechnologyEvaluationDto.setAdministrationFrequencyScore(extractLastNumber(jsonObject.getString("score")));
        trTechnologyEvaluationDto.setAdministrationFrequencyContent(jsonObject.getString("content"));

//        //包装规格
//        //todo 先直接赋值
//        trTechnologyEvaluationDto.setPackagingSpecificationScore(0.0);
//        trTechnologyEvaluationDto.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");
//
//        //大包装
//        //todo 先直接赋值
//        trTechnologyEvaluationDto.setLargePackageAdoptionScore(0.0);
//        trTechnologyEvaluationDto.setLargePackageAdoptionOption("最小包装使用人次数高于对照药");
//
//        //单剂量
//        //todo 先直接赋值
//        trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
//        trTechnologyEvaluationDto.setSingleDoseScore(0.0);

        //疗程
        String coursePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "1.首先，根据我提供的内容，先判断是否有“疗程”相关原文内容，若有，请帮我挑选出药品疗程相关的内容；若没有相关的则返回暂无疗程相关内容 +\n" +
                "2.结合以下评分规则，给出药品使用疗程的最终得分：（单选）\n"+
                "疗程有明确限定：1分；\n"+
                "未提及疗程：0分。\n";
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content", "药品疗程相关的内容");
        stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
        //JSONObject jsonObject1 = lxGptService.executeGptPlus(coursePrompt, "course", responseFormat1, "","1,0");
        JSONObject jsonObject1 = getGptJson(coursePrompt, "course", "","1,0");
        trTechnologyEvaluationDto.setCourseOfTreatmentScore(extractLastNumber(jsonObject1.getString("score")));
        trTechnologyEvaluationDto.setCourseOfTreatmentContent(jsonObject1.getString("content"));

        //存储
        String storagePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getStorage() + "*****，" +
                "作为一名专业的药师，请根据说明书原文内容，结合以下打分规则进行评分。\n" +
                "1分：常温贮藏\n" +
                "0.5分：需阴凉或避光/遮光贮藏\n" +
                "注意：当说明书中【贮藏】中明确提及“阴凉”、“20℃以下”、“遮光”、“避光”等时，直接给0.5分,反之，需要给1分。\n只返回一个数字，不要其他的内容";
        String gpt = lxGptService.getGpt(storagePrompt, "", "1,0.5");
        trTechnologyEvaluationDto.setStorageScore(extractLastNumber(gpt));
        trTechnologyEvaluationDto.setStorageContent(drugInfoNew.getStorage());

        //有效期
        String validityPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getIndate() + "*****，" +
                "请帮我打分，药品有效期大于24个月1分，小于24个月0分，只返回一个数字";
        String gpt1 = lxGptService.getGpt(validityPrompt, "", "1,0");
        trTechnologyEvaluationDto.setValidityPeriodScore(extractLastNumber(gpt1));
        if (StringUtils.isNotEmpty(drugInfoNew.getIndate())) {
            trTechnologyEvaluationDto.setValidityPeriodContent(drugInfoNew.getIndate());
        }else {
            trTechnologyEvaluationDto.setValidityPeriodContent("说明书中无相关内容。");
            trTechnologyEvaluationDto.setValidityPeriodScore(0.0);

        }
        if (StringUtils.isNotEmpty(drugInfoNew.getIsProtected())) {
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
            String protectionLevel = drugInfoNew.getProtectionLevel();
            String protectionPeriod = drugInfoNew.getProtectionPeriod();
            if (StringUtils.isNotEmpty(protectionLevel)) {
                trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent(protectionLevel + protectionPeriod);
                if (protectionLevel.contains("级") && !protectionLevel.contains("已过保护期")) {
                    trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(3.0);
                } else if (protectionLevel.contains("已过保护期")) {
                    trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(2.0);
                } else {
                    trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
                }
            }
        } else {
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
            trTechnologyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent("该产品不是国家保护品种");
        }


        //药典
        if (StringUtils.isNotEmpty(drugInfoNew.getIsInclude()) && "收载在《中国药典》中。".equals(drugInfoNew.getIsInclude())) {
            String chineseMedicine = "本品已收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(1.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);

        } else {
            String chineseMedicine = "本品未收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(0.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
        }


        //专利
        //使用prompt
        Criteria criteria = new Criteria().andOperator(
                Criteria.where("title").regex(".*" + drugInfoNew.getDrugName() + ".*"),
                Criteria.where("patentee").is(drugInfoNew.getManufacturer())
        ).and("applicationTime").exists(true);

        // 创建 Query 对象并添加 Criteria 和排序
        Query query = new Query(criteria);
        query.with(Sort.by(Sort.Direction.DESC,"applicationTime"));
        List<Patent> patents = mongoTemplate.find(query, Patent.class);
        if (CollUtil.isNotEmpty(patents)) {
            // 拼接专利信息
            Double patentScore = 0.0;
            ArrayList<String> strings = new ArrayList<>();
            StringBuilder patentInfo = new StringBuilder();
            for (int i = 0; i < patents.size(); i++) {
                Patent patent = patents.get(i);
                patentInfo.append("（").append(i + 1).append("）").append(patent.getTitle()).append("\n")
                        .append("  专利类型：").append(patent.getType()).append("；申请/专利号：").append(patent.getPatentNumber()).append("；申请/专利权人：").append(String.join("、", patent.getPatentee())).append("\n")
                        .append("  申请日：").append(patent.getApplicationTime()).append("；公开日：").append(patent.getPublicDate()).append("； 法律状态信息：").append(patent.getStatusInformation());
                strings.add(patent.getStatusInformation());
                // 如果不是最后一个元素，则添加换行符
                if (i < patents.size() - 1) {
                    patentInfo.append("\n");
                }
            }
            patentScore = GptCallUtil.getPatentScoreMax(strings);
            trTechnologyEvaluationDto.setPatentScore(patentScore);

            trTechnologyEvaluationDto.setPatentNumber(patentInfo.toString());


        }else {


            String patentsPrompt = "药品" + drugInfoNew.getDrugName() + "中成药是否获得过专利？若有，请提供准确的专利号，若无，请不要提供虚假或者假设信息，直接输出'暂未查询到药品的相关专利信息。'就可以。";
            String gpt2 = lxGptService.getGpt(patentsPrompt, "","");
            if (gpt2.contains("无相关专利") || gpt2.contains("暂未查询到药品的相关专利信息")) {
                trTechnologyEvaluationDto.setPatentScore(0.0);
                trTechnologyEvaluationDto.setPatentNumber("无相关专利");
            } else {
                trTechnologyEvaluationDto.setPatentScore(1.0);
                trTechnologyEvaluationDto.setPatentNumber(gpt2);
            }}

        //是否是独家品种
        List<DrugInfoNew> drugName = mongoTemplate.find(Query.query(Criteria.where("drugName").is(drugInfoNew.getDrugName())), DrugInfoNew.class);
        HashSet<String> strings = new HashSet<>();
        for (DrugInfoNew infoNew : drugName) {
            strings.add(infoNew.getManufacturer());
        }

        HashSet<String> strings1 = new HashSet<String>();
        for (String string : strings) {
            if (string.contains("集团")) {
                strings1.add(string.split("集团")[0] + "集团");
            }else {
            strings1.add(string);}
        }

        if (strings1.size() <= 1) {
            trTechnologyEvaluationDto.setExclusiveVarietyScore(1.0);
            trTechnologyEvaluationDto.setExclusiveVarietyInfo("该药品是独家品种");
        } else if (strings1.size() > 1) {
            trTechnologyEvaluationDto.setExclusiveVarietyScore(0.0);
            String s = "";
            int i = 0;
            for (String string : strings) {
                s += drugInfoNew.getDrugName() + "-" + string + "\n";
                if (i >= 2) {
                    break;
                }
                i++;
            }
            trTechnologyEvaluationDto.setExclusiveVarietyInfo("该药品不是独家品种");
            trTechnologyEvaluationDto.setExclusiveVarietyInfo(s.substring(0, s.length() - 1));
        }

        trTechnologyEvaluationDto.setAdditionalZodiacScore();
        trTechnologyEvaluationDto.setSuitabilityScore();
        trTechnologyEvaluationDto.setTotalScore();

        addProcessx(id, step++, "<b>4、技术评价</b>", stringBuilderx);
        addProcessx(id, step++, "<b>4.1 适宜性</b>", stringBuilderx);
        addProcessx(id, step++, "<b>4.1.1 给药频次</b>", stringBuilderx);
        addProcess(id, step++, trTechnologyEvaluationDto.getAdministrationFrequencyContent(), stringBuilderx);

        if (StringUtils.isNotEmpty(trTechnologyEvaluationDto.getPackagingSpecificationOption())) {
            switch (trTechnologyEvaluationDto.getPackagingSpecificationOption()) {
                case "1":
                    trTechnologyEvaluationDto.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");
                    trTechnologyEvaluationDto.setPackagingSpecificationScore(1.0);
                    break;
                case "2":
                    trTechnologyEvaluationDto.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为非整数)");
                    trTechnologyEvaluationDto.setPackagingSpecificationScore(0.5);
                    break;

            }
        } else {
            trTechnologyEvaluationDto.setPackagingSpecificationOption("暂无内容");
        }


        addProcessx(id, step++, "<b>4.1.2 包装规格</b>", stringBuilderx);
        addProcessCache(id, step++, trTechnologyEvaluationDto.getPackagingSpecificationOption(), stringBuilderx, CacheNameEnum.CACHE_Packaging);

        if (StringUtils.isNotEmpty(trTechnologyEvaluationDto.getLargePackageAdoptionOption())) {
            switch (trTechnologyEvaluationDto.getLargePackageAdoptionOption()) {
                case "1":
                    trTechnologyEvaluationDto.setLargePackageAdoptionOption("最小包装使用人次数高于对照药");
                    trTechnologyEvaluationDto.setLargePackageAdoptionScore(1.0);
                    break;
                case "2":
                    trTechnologyEvaluationDto.setLargePackageAdoptionOption("最小包装使用人次数低于对照药");
                    trTechnologyEvaluationDto.setLargePackageAdoptionScore(0.0);
                    break;
            }
        } else {
            trTechnologyEvaluationDto.setLargePackageAdoptionOption("暂无内容");
        }

        addProcessx(id, step++, "<b>4.1.3 采用大包装</b>", stringBuilderx);
        addProcessCache(id, step++, trTechnologyEvaluationDto.getLargePackageAdoptionOption(), stringBuilderx, CacheNameEnum.CACHE_LARGE_PACKAGING);

        if (StringUtils.isNotEmpty(trTechnologyEvaluationDto.getSingleDoseOption())) {
            switch (trTechnologyEvaluationDto.getSingleDoseOption()) {
                case "1":
                    trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
                    trTechnologyEvaluationDto.setSingleDoseScore(1.0);
                    break;
                case "2":
                    trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值>1)");
                    trTechnologyEvaluationDto.setSingleDoseScore(0.8);
                    break;
                case "3":
                    trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值<1)");
                    trTechnologyEvaluationDto.setSingleDoseScore(0.5);
                    break;
            }
        } else {
            trTechnologyEvaluationDto.setSingleDoseOption("暂无内容");
        }

        addProcessx(id, step++, "<b>4.1.4 单次用量</b>", stringBuilderx);
        addProcessCache(id, step++, trTechnologyEvaluationDto.getSingleDoseOption(), stringBuilderx, CacheNameEnum.SINGLE_MEDICATION);
        addProcessx(id, step++, "<b>4.1.5 疗程</b>", stringBuilderx);
        addProcess(id, step++, trTechnologyEvaluationDto.getCourseOfTreatmentContent(), stringBuilderx);
        addProcessx(id, step++, "<b>4.1.6 贮藏</b>", stringBuilderx);
        addProcess(id, step++, trTechnologyEvaluationDto.getStorageContent(), stringBuilderx);
        addProcessx(id, step++, "<b>4.1.7 有效期</b>", stringBuilderx);
        addProcess(id, step++, String.valueOf(trTechnologyEvaluationDto.getValidityPeriodContent()), stringBuilderx);
        addProcessx(id, step++, "<b>4.2 国家中药保护品种</b>", stringBuilderx);
        addProcess(id, step++, String.valueOf(trTechnologyEvaluationDto.getNationalTraditionalChineseMedicineProtectionContent()), stringBuilderx);
        addProcessx(id, step++, "<b>4.3 附加属性</b>", stringBuilderx);
        addProcessx(id, step++, "<b>4.3.1 中国药典</b>", stringBuilderx);
        addProcess(id, step++, String.valueOf(trTechnologyEvaluationDto.getChinesePharmacopoeiaContent()), stringBuilderx);
        addProcessx(id, step++, "<b>4.3.2 专利</b>", stringBuilderx);
        addProcess(id, step++, trTechnologyEvaluationDto.getPatentNumber(), stringBuilderx);
        addProcessx(id, step++, "<b>4.3.3 独家品种</b>", stringBuilderx);
        addProcess(id, step++, trTechnologyEvaluationDto.getExclusiveVarietyInfo(), stringBuilderx);


        return step;

    }

    //市场评价
    public int getTrMarketEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrMarketEvaluationDto trMarketEvaluationDto) {
        //市场独特性
        //todo  先直接赋值
//
//        trMarketEvaluationDto.setMarketUniquenessScore(0.0);
//        trMarketEvaluationDto.setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");
//
//        //经济性
//        trMarketEvaluationDto.setEconomicScore(0.0);
//        trMarketEvaluationDto.setEconomicOption("日均治疗费用较同类中成药价格较低，且具有明显的药物经济学优势");

        //国家基本药物
        String essentialMedicines = drugInfoNew.getEssentialMedicines();

        if (StringUtils.isNotEmpty(essentialMedicines) && "是".equals(essentialMedicines)) {
            trMarketEvaluationDto.setNationalEssentialDrugsScore(3.0);
            trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品被《国家基本药物目录》收载");
        } else {
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
                    medicalInsuranceContent += "，有支付限制，" + drugInfoNew.getPaymentScope();
                } else {
                    isInsuranceScore = 3.00F;
                    medicalInsuranceContent += "，无支付限制";
                }
            } else {
                medicalInsuranceContent = "该药品属于医乙类";
                if (paymentScopeStatus) {
                    isInsuranceScore = 1.50F;
                    medicalInsuranceContent += "，有支付限制，" + drugInfoNew.getPaymentScope();
                } else {
                    isInsuranceScore = 2.00F;
                    medicalInsuranceContent += "，无支付限制";
                }
            }
        } else {
            medicalInsuranceContent = "该药品不属于医保药品";
        }
        trMarketEvaluationDto.setNationalMedicalInsuranceDrugsScore(isInsuranceScore);
        trMarketEvaluationDto.setNationalMedicalInsuranceDrugsPaymentRequirement(medicalInsuranceContent);

        //集采

        //是否得分
        boolean isConcentrate = true;
        String isTheAgreementForTheJudgment = drugInfoNew.getIsTheAgreementForTheJudgment();
        String termOfAgreement = drugInfoNew.getTermOfAgreement();
        String drugCollection = drugInfoNew.getDrugCollection();
        if ("不属于国家/联盟集中采购药品。".equals(drugCollection)) {
            isConcentrate = false;
        }


        if (StringUtils.isNotEmpty(isTheAgreementForTheJudgment)||StringUtils.isNotEmpty(termOfAgreement)) {
            drugCollection += "\n";
        }else {
            drugCollection += "\n不属于协议期内国家谈判品种。";
        }

        if (StringUtils.isNotEmpty(isTheAgreementForTheJudgment)) {
            drugCollection += isTheAgreementForTheJudgment;
            isConcentrate = true;
        }
        if (StringUtils.isNotEmpty(termOfAgreement)) {
            drugCollection += termOfAgreement;
            isConcentrate = true;
        }

        if (isConcentrate) {
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsScore(1.0);
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsSource(drugCollection);
        } else {
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsScore(0.0);
            trMarketEvaluationDto.setCentralizedVolumePurchasingDrugsSource(drugCollection);
        }
        trMarketEvaluationDto.setPolicyAttributeScore();

        addProcess(id, step++, "<b>5、市场评价</b>", stringBuilder);

        if (StringUtils.isNotEmpty(trMarketEvaluationDto.getMarketUniquenessOption())) {
            switch (trMarketEvaluationDto.getMarketUniquenessOption()) {
                case "1":
                    trMarketEvaluationDto.setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");
                    trMarketEvaluationDto.setMarketUniquenessScore(3.0);
                    break;
                case "2":
                    trMarketEvaluationDto.setMarketUniquenessOption("与已上市的同类药品相比具有独特优势");
                    trMarketEvaluationDto.setMarketUniquenessScore(2.0);
                    break;
                case "3":
                    trMarketEvaluationDto.setMarketUniquenessOption("市面上有同类药品");
                    trMarketEvaluationDto.setMarketUniquenessScore(1.0);
                    break;
            }
        } else {
            trMarketEvaluationDto.setMarketUniquenessOption("暂无内容");
        }

        addProcessx(id, step++, "<b>5.1 市场独特性</b>", stringBuilder);

        addProcessCache(id, step++, trMarketEvaluationDto.getMarketUniquenessOption(), stringBuilder, CacheNameEnum.UNIQUENES);

        if (StringUtils.isNotEmpty(trMarketEvaluationDto.getEconomicOption())) {
            switch (trMarketEvaluationDto.getEconomicOption()) {

                case "1":
                    trMarketEvaluationDto.setDailyTreatmentCostOption("日均治疗费用较同类中成药价格较低");
                    trMarketEvaluationDto.setDailyTreatmentCostScore(3.0);
                    break;
                case "2":
                    trMarketEvaluationDto.setDailyTreatmentCostOption("日均治疗费用较同类中成药价格相当");
                    trMarketEvaluationDto.setDailyTreatmentCostScore(2.0);
                    break;
                case "3":
                    trMarketEvaluationDto.setDailyTreatmentCostOption("日均治疗费用较同类中成药价格高");
                    trMarketEvaluationDto.setDailyTreatmentCostScore(1.0);
                    break;
            }
        } else {
            trMarketEvaluationDto.setEconomicOption("暂无内容");
        }

        addProcessx(id, step++, "<b>5.2 经济性</b>", stringBuilder);
        addProcessx(id, step++, "<b>5.2.1 日均治疗费用</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getDailyTreatmentCostOption(), stringBuilder);


        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugInfoNew.getDrugName());
        StringBuilder stringBuilderx = new StringBuilder();
        StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilderx, drugZhs, "标题,摘要");
        TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 12);

//        stringBuilder1.append(" AND ");
//        ArrayList<String> strings = new ArrayList<>();
//        strings.add("经济");
//        StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "标题");
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", stringBuilder1.toString());
        jsonObject.put("type", "1");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);

        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(wrapperQueryBuilder);
        boolQueryBuilder.must().add(termQueryBuilder);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);

        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        StringBuilder stringBuilder3 = new StringBuilder();
        addProcessx(id, step++, "<b>5.2.2 经济学优势</b>", stringBuilder);

        if (CollUtil.isNotEmpty(literatureSearchHits)) {
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                JSONObject jsonObject1 = new JSONObject();
                jsonObject1.put("title", HtmlUtil.cleanHtmlTag(literatureSearchHit.getContent().getTitle()));
                stringBuilder3.append("标题：" + literatureSearchHit.getContent().getTitle());
                addProcess(id, step++,  literatureSearchHit.getContent().getTitle(), stringBuilder);
                jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                stringBuilder3.append("摘要：" + literatureSearchHit.getContent().getSummary());
//                addProcess(id, step++, "摘要：" + literatureSearchHit.getContent().getSummary(), stringBuilder);
                jsonObjects.add(jsonObject1);
                //最多十篇
                if (jsonObjects.size() >= 10) {
                    break;
                }
            }
        } else {
            addProcess(id, step++, "暂无内容", stringBuilder);
        }
        trMarketEvaluationDto.setEconomicAdvantageOption(jsonObjects);


        if (jsonObjects.size() != 0) {
            String prompt = "你作为一名中药物经济学专家，请根据我提供的经济学相关文献的摘要信息，判断一下" + drugInfoNew.getDrugName() + "与对比药物相比，" + drugInfoNew.getDrugName() + "是否具有经济学优势（若未提供文献，则代表无经济学优势）：\n" +
                    "并根据以下评分规则进行评分（单选）" +
            "2分：有经济学优势；" +
            "0分：无经济学优势；\n" +
            "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
                    "经济学文献：\n" +
              stringBuilder3.toString();
            String gpt = lxGptService.getGpt(prompt, "","2,0");

                trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber(gpt));

        } else {
            trMarketEvaluationDto.setEconomicAdvantageScore(0.0);
        }
        trMarketEvaluationDto.setEconomicScore();


        addProcessx(id, step++, "<b>5.3 政策属性</b>", stringBuilder);
        addProcessx(id, step++, "<b>5.3.1 国家基本药物</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getNationalEssentialDrugsRequirement(), stringBuilder);
        addProcessx(id, step++, "<b>5.3.2 国家医保药品</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getNationalMedicalInsuranceDrugsPaymentRequirement(), stringBuilder);
        addProcessx(id, step++, "<b>5.3.3 集中带量采购药品或国家谈判品种（协议期内）</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsSource(), stringBuilder);


        //生产企业情况
        //prompt判断
        String productionEnterpriseStatusPrompt = "药品" + drugInfoNew.getDrugName() + "企业为*****" + drugInfoNew.getManufacturer() + "*****，" +
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
                "示例：“太极集团重庆涪陵制药厂有限公司”隶属于“太极集团有限公司”，而“太极集团”在我提供的数据表的《中国中药企业TOP100排行榜》中，故给2分。";

        String productionEnterpriseStatusPromptx = "药品" + drugInfoNew.getDrugName() + "企业为*****" + drugInfoNew.getManufacturer() + "*****，" +
                "药品成分为：" + drugInfoNew.getIngredient() + "，" +
                "请判断： 该生产企业是否拥有独立的GAP种植基地？若有，请给出种植基地种植的药物是什么？再请判断下这个GAP种植基地中种植的药物是否属于药品成份中的一个？" +
                "打分：有种植基地且属于成分，则返回1分，否则返回0分";

        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content", "相关内容");
        stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
        //JSONObject jsonObject2 = lxGptService.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", responseFormat2, "","3,2,1");
        JSONObject jsonObject2 = getGptJson(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", "","3,2,1");
        //JSONObject jsonObject3 = lxGptService.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", responseFormat2, "","1,0");
        JSONObject jsonObject3 = getGptJson(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", "","1,0");

        trMarketEvaluationDto.setProductionEnterpriseScore(extractLastNumber(jsonObject2.getString("score")));
        trMarketEvaluationDto.setProductionEnterpriseContent(jsonObject2.getString("content"));

        trMarketEvaluationDto.setOwnPlantingBaseOption(jsonObject3.getString("content"));
        trMarketEvaluationDto.setOwnPlantingBaseScore(extractLastNumber(jsonObject3.getString("score")));


        addProcessx(id, step++, "<b>5.4 生产企业状况</b>", stringBuilder);
        addProcessx(id, step++, "<b>5.4.1 生产企业排名</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getProductionEnterpriseContent(), stringBuilder);
        addProcessx(id, step++, "<b>5.4.2 独立的GAP种植基地或全流程质量可追溯体系</b>", stringBuilder);
        addProcess(id, step++, trMarketEvaluationDto.getOwnPlantingBaseOption(), stringBuilder);


        trMarketEvaluationDto.setProductionEnterpriseStatusScore(Double.parseDouble(jsonObject2.getString("score")) + Double.parseDouble(jsonObject3.getString("score")));
        trMarketEvaluationDto.setPolicyAttributeScore();
        trMarketEvaluationDto.setProductionEnterpriseStatusScore();


        trMarketEvaluationDto.setTotalScore();


        addProcess(id, step++, "-END-", stringBuilder);

        return step;


    }

    private boolean containsName(String block, List<String> drugNames) {
        for (String drugName : drugNames) {
            if (block.contains(drugName)) {
                return true;
            }
        }
        return false;
    }
}
