package com.sentum.service.impl;

import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.RetryException;
import com.github.rholder.retry.Retryer;
import com.sentum.enums.PromptEnum;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.DrugToModel;
import com.sentum.pojo.dto.DrugAddDto;
import com.sentum.service.ERNIE_Bot;
import com.sentum.service.PromptAndToModelClassic;
import com.sentum.util.GptUtil;
import com.sentum.util.GuavaRetryer;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.BeanWrapper;
import org.springframework.beans.BeanWrapperImpl;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.beans.PropertyDescriptor;
import java.util.*;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

@Service
@Slf4j
public class PromptAndToModelClassicImpl implements PromptAndToModelClassic {


    @Autowired
    RedisTemplate<String, Object> redisTemplate;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private MedicineFeign medicineFeign;

    @Autowired
    private GptUtil gptUtil;

    private String youyideyi(String msg) {
        long ts = System.currentTimeMillis();
        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
        //["gpt-3.5-turbo","gpt-4-0613"]
//        jsonObject1.put("model", "gpt-4-0613");  // 112068
//        jsonObject1.put("model", "gpt-3.5-turbo");  // 慢  105605
        //      jsonObject1.put("model", "gpt-4");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-3.5-turbo-16k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-4-32k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
        jsonObject1.put("model", "gpt-4-0125-preview");
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
            return response.replaceAll("[\r\n]", "");
        }
        return "";
    }


    private String xiaoling(String search, String prompt) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("prompt", prompt);
        jsonObject.put("word", search);
        String s = medicineFeign.gptForPharmacy(jsonObject);
        log.info("小灵返回{}", s);
        return s.replaceAll("\n", "");
    }

    private String chat(String msg) {
//        log.info("query:{}",msg);
        try {
            return youyideyi(msg);
            //return ernie_bot.chat(msg);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return "";
        }
    }


    /**
     * 文新一言
     */
    private String wenChat(String msg) {
        log.info("query:{}", msg);
        try {
            ERNIE_Bot bot = new ERNIE_Bot();
            return bot.chat(msg);
            //return ernie_bot.chat(msg);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            return "";
        }
    }


    /**
     * 不良反应评分---历史版本
     *
     * @param drugName    药品名称
     * @param instruction 说明书
     * @return 不良反应评分
     */
    private JSONObject adrs(String drugName, String instruction) throws ExecutionException, RetryException {
        String query;
        if (StrUtil.isNotBlank(instruction)) {
            query = "请根据提供的不良反应" + instruction + "来具体描述一下药品" + drugName + "的发生该不良反应的发生率，并按照以下规则进行打分，请给出最终的得分。规则如下：" +
                    "1、明确描述无严重不良反应（16分）。\n" +
                    "2、描述有严重不良反应，发生率罕见(0.01％~0.1％，含 0.01％)（12分）。\n" +
                    "3、描述有严重不良反应，发生率偶见（0.1％~1％，含 0.1％)（8分）。\n" +
                    "4、描述有严重不良反应，发生率常见（1％-10%，含 1%） 或十分常见（4分）。\n" +
                    "严重药品不良反应是指因使用药品引起以下损害情形之一的反应：\n" +
                    "（1）导致死亡；（2）危及生命；（3）致癌、致畸生缺陷；（4）导致显著的或者永久的人体伤残或者器官功能的损伤（5）导致住院或者住院时间延长；（6）导致其他重要医学事件。" +
                    "分析结果请严格使用json格式进行回答,其中字段score为得分,reason为分析理由。";

        } else {
            query = "请具体描述药品" + drugName + "会出现哪些严重不良反应，并根据其不良反应按照以下规则进行打分，请给出最终的得分。规则如下：" +
                    "1、明确描述无严重不良反应（16分）。\n" +
                    "2、描述有严重不良反应，发生率罕见(0.01％~0.1％，含 0.01％)（12分）。\n" +
                    "3、描述有严重不良反应，发生率偶见（0.1％~1％，含 0.1％)（8分）。\n" +
                    "4、描述有严重不良反应，发生率常见（1％-10%，含 1%） 或十分常见（4分）。\n" +
                    "严重药品不良反应是指因使用药品引起以下损害情形之一的反应：\n" +
                    "（1）导致死亡；（2）危及生命；（3）致癌、致畸生缺陷；（4）导致显著的或者永久的人体伤残或者器官功能的损伤（5）导致住院或者住院时间延长；（6）导致其他重要医学事件。" +
                    "分析结果请严格使用json格式进行回答,其中字段score为得分,reason为分析理由。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "adrs");
        });
    }


    /**
     * 指南不良反应评分---历史版本
     *
     * @param drugName 药品名称
     * @return 不良反应评分
     */
    private JSONObject guideAdrsScore(String drugName) throws ExecutionException, RetryException {
        String query = "假如你现在是一个药学科研人员，请按照规则对" + drugName + "的以下5个维度进行评分：中度不良反应、重度不良反应、特殊人群、药物相互作用、其他不良反应。结果以JSON格式返回，每个字段都为数字。规则如下：\n" +
//                "不良反应（得分为中度不良反应和重度不良反应相加，最高8分，不得超过8分，超过取8分）\n" +
                "中度不良反应（最高3分，不得超过3分，超过取3分）： \n" +
                "3分 发生率＜1% ；" +
                "2分 发生率 1%~10% ；" +
                "1分 发生率≥10% ；" +
                "0分 未提供 ADR 发生数据 \n" +
                "重度不良反应（最高5分，不得超过5分，超过取5分）：\n" +
                "5分 发生率＜0.01% ；" +
                "4分 发生率 0.01%~0.1% ；" +
                "3分 发生率 0.1%~1% ；" +
                "2分 发生率 1%~10 % ；" +
                "1分 发生率≥10% ；" +
                "0分 未提供 ADR 发生数据 \n" +
                "特殊人群（其中儿童只能选择一项，最终将儿童、老人、妊娠期妇女、哺乳期妇女、肝功能异常、肾功能异常得分加和。最高11分，不得超过11分，超过取11分） \n" +
                "儿童可用（其中2 个月以上儿童可用 2分，" +
                "3 个月以上儿童可用 1.9分，" +
                "6 个月以上儿童可用 1.8分，" +
                "9 个月以上儿童可用 1.7，" +
                "1 岁以上儿童可用 1.6分，" +
                "2 岁以上儿童可用 1.5分，" +
                "3 岁以上儿童可用1.4，" +
                "4 岁以上儿童可用 1.3，" +
                "5 岁以上儿童可用 1.2分，" +
                "6 岁以上儿童可用 1.1分，" +
                "7 岁以上儿童可用 1.0分，" +
                "8 岁以上儿童可用 0.9分，" +
                "9 岁以上儿童可用 0.8分，" +
                "10 岁以上儿童可用 0.7分，" +
                "11 岁以上儿童可用 0.6分，" +
                "12 岁以上儿童可用 0.5分）；" +
                "老人可用（可用 1，慎用 0.5）；" +
                "妊娠期妇女可用（可用 1分，慎用 0.5分）；" +
                "哺乳期妇女可用（可用 1分，慎用 0.5分）；" +
                "肝功能异常可用（重度可用 3，中度可用 1，轻度可用 1）；" +
                "肾功能异常可用（重度可用 3分，中度可用 1分，轻度可用 1分）。\n" +
                "药物相互作用（最高3分，不得超过3分，超过取3分）\n" +
                "3分 无需调整用药剂量；" +
                "2分 需要调整用药剂量；" +
                "1分 禁止在同一时段使用。\n" +
                "其他不良反应（可多选，最高3分，不得超过3分，超过取3分）\n" +
                "1分 不良反应均为可逆性；" +
                "1分 无致畸、致癌；" +
                "1分 无特别用药警示。\n" +
//                    "结果请严格使用Json格式进行回答，请快速给出得分。";
                "分析结果请严格采用JSON格式输出，其中字段中度不良反应得分为mildAdverseReactionScore，重度不良反应得分为severeAdverseReactionScore，" +
                "特殊人群中（儿童得分为childrenScore、老人得分为oldManScore、妊娠期妇女得分为pregnantScore、哺乳期妇女得分为lactatingScore、肝功能异常得分为liverScore、肾功能异常得分为kidneyScore），药物相互作用得分为drugInteractionScore，其他不良反应得分为otherAdverseReactionScore。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "guideAdrsScore");
        });
    }

    private JSONObject adverseReactionAnalysis(String drugName, String adverseReaction) throws ExecutionException, RetryException {
        String query = "";
        if (Objects.nonNull(adverseReaction) && StrUtil.isNotBlank(adverseReaction)) {
            query = "假如你现在是一个药学科研人员，请从" + adverseReaction + "这句话中挑选出药品：" + drugName + "的中度不良反应和重度不良反应症状都有哪些。并且根据分析出来的结果进行打分，打分规则如下：\n" +
                    "1、使用" + drugName + "以后会出现中度不良反应发生率（单选，根据挑选出来的所有中度不良反应进行打分，最高得分3分）： \n" +
                    "3分 发生率＜1% ；" +
                    "2分 发生率 1%~10% ；" +
                    "1分 发生率≥10% ；" +
                    "0分 未提供 ADR 发生数据 \n" +
                    "2、使用" + drugName + "以后会出现重度不良反应发生率（单选，根据挑选出来的所有重度不良反应进行打分，最高得分5分）：\n" +
                    "5分 发生率＜0.01% ；" +
                    "4分 发生率 0.01%~0.1% ；" +
                    "3分 发生率 0.1%~1% ；" +
                    "2分 发生率 1%~10 % ；" +
                    "1分 发生率≥10% ；" +
                    "0分 未提供 ADR 发生数据 \n" +
                    "分析结果请严格使用json格式进行回答，其中字段，" +
                    "中度不良反应症状为mildAdverseReaction，" +
                    "重度不良反应症状为severeAdverseReaction，" +
                    "中度不良反应得分为mildAdverseReactionScore，" +
                    "重度不良反应得分为severeAdverseReactionScore。" +
                    "分析的过程字段为process。" +
                    "请将重度不良反应症状和轻度不良反应症状都返回成一段话，返回结果中只包含不良症状。";
        } else {
            query = "假如你现在是一个药学科研人员,请给出药品：" + drugName + "的" +
                    "1、中度不良反应（尽可能详细说明，文本格式）；" +
                    "2、重度不良反应（尽可能详细说明，文本格式）都有哪些。并且根据分析出来的结果进行打分，打分规则如下：\n" +
                    "中度不良反应（单选，根据挑选出来的所有中度不良反应进行打分，最高得分3分）： \n" +
                    "3分 发生率＜1% ；" +
                    "2分 发生率 1%~10% ；" +
                    "1分 发生率≥10% ；" +
                    "0分 未提供 ADR 发生数据 \n" +
                    "重度不良反应（单选，根据挑选出来的所有重度不良反应进行打分，最高得分5分）：\n" +
                    "5分 发生率＜0.01% ；" +
                    "4分 发生率 0.01%~0.1% ；" +
                    "3分 发生率 0.1%~1% ；" +
                    "2分 发生率 1%~10 % ；" +
                    "1分 发生率≥10% ；" +
                    "0分 未提供 ADR 发生数据 \n" +
                    "分析结果请严格使用json格式进行回答，其中字段，" +
                    "中度不良反应症状为mildAdverseReaction，" +
                    "重度不良反应症状为severeAdverseReaction，" +
                    "中度不良反应得分为mildAdverseReactionScore，" +
                    "重度不良反应得分为severeAdverseReactionScore。" +
                    "分析的过程字段为process。" +
                    "请将重度不良反应症状和轻度不良反应症状都返回成一段话，返回结果中只包含不良症状。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "adverseReactionAnalysis");
        });
    }

    public JSONObject specialCrowdAnalysis(String drugName, String instruction) throws ExecutionException, RetryException {

        String query = "假如你现在是一个药学科研人员，请给出药品：" + drugName + "，对于儿童（如果儿童可用，对于几岁儿童可用，和使用建议）、老人（如果老人可用，是可用还是慎用，和使用建议）、妊娠期及哺乳期妇女（如果可用，是可用还是慎用，和使用建议）、肝肾功能异常者的使用情况（如果可用，是重度可用，还是中度可用，还是轻度可用，和使用建议），请将使用情况和建议合并成一句话，不要分成多个字段返回。" +
                "分析结果请严格使用json格式进行回答，其中的返回字段如下：" +
                "1、pregnantWomen（妊娠期及哺乳期妇女），" +
                "2、childrenMedicine（儿童），" +
                "3、geriatricMedicine（老年），" +
                "4、liverKidney（肝肾功异常者）。";
        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "specialCrowdAnalysis");
        });
    }

    public JSONObject specialCrowdScore(JSONObject specialCrowdAnalysis, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder str = new StringBuilder();
        if (StrUtil.isNotBlank(drugInfo.getPregnantWomen())) {
            str.append("1、妊娠期妇女及哺乳期妇女使用情况：").append(drugInfo.getPregnantWomen());
        } else {
            str.append("1、妊娠期妇女及哺乳期妇女使用情况：").append(specialCrowdAnalysis.getString("pregnantWomen"));
        }
        if (StrUtil.isNotBlank(drugInfo.getChildrenMedicine())) {
            str.append("2、儿童使用情况：").append(drugInfo.getChildrenMedicine());
        } else {
            str.append("2、儿童使用情况：").append(specialCrowdAnalysis.getString("childrenMedicine"));
        }
        if (StrUtil.isNotBlank(drugInfo.getGeriatricMedicine())) {
            str.append("3、老人使用情况：").append(drugInfo.getGeriatricMedicine());
        } else {
            str.append("3、老人使用情况：").append(specialCrowdAnalysis.getString("geriatricMedicine"));
        }
        str.append("4、肝肾功能异常者使用情况：").append(specialCrowdAnalysis.getString("liverKidney"));

        String query = "假如你现在是一个药学科研人员，请根据提供的如下资料：" +
                str.toString() + "。按照如下规则进行打分：\n" +
                "（1）儿童使用情况（单选,只选择其中一项）：\n" +
                "2个月以上儿童可用 2分，" +
                "3个月以上儿童可用 1.9分，" +
                "6个月以上儿童可用 1.8分，" +
                "9个月以上儿童可用 1.7，" +
                "1岁以上儿童可用 1.6分，" +
                "2岁以上儿童可用 1.5分，" +
                "3岁以上儿童可用 1.4，" +
                "4岁以上儿童可用 1.3，" +
                "5岁以上儿童可用 1.2分，" +
                "6岁以上儿童可用 1.1分，" +
                "7岁以上儿童可用 1.0分，" +
                "8岁以上儿童可用 0.9分，" +
                "9岁以上儿童可用 0.8分，" +
                "10岁以上儿童可用 0.7分，" +
                "11岁以上儿童可用 0.6分，" +
                "12岁以上儿童可用 0.5分," +
                "不可用 0分）；\n" +
                "（2）老人使用情况（单选）：\n" +
                "可用 1分，慎用 0.5分，不可用 0分；\n" +
                "（3）妊娠期妇女使用情况（单选）：\n" +
                "可用 1分，慎用 0.5分，不可用 0分；\n" +
                "（4）哺乳期妇女使用情况（单选）：\n" +
                "可用 1分，慎用 0.5分，不可用 0分；\n" +
                "（5）肝功能异常使用情况（单选）：\n" +
                "重度可用 3分，中度可用 1分，轻度可用，不可用 0分 1分；\n" +
                "（6）肾功能异常使用情况（单选）：\n" +
                "重度可用 3分，中度可用 1分，轻度可用，不可用 0分 1分。\n" +
                "分析结果请严格使用json格式进行回答，其中字段，" +
                "1、childrenScore(儿童使用情况得分)，" +
                "2、geriatricScore(老人使用情况得分)，" +
                "3、pregnantScore(妊娠期妇女使用情况得分)，" +
                "4、lactatingScore(哺乳期妇女使用情况得分)，" +
                "5、liverScore(肝功能异常者使用情况得分)，" +
                "6、kidneyScore(肾功能异常者使用情况得分)。";
//
        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "specialCrowdScore");
        });
    }

    public JSONObject drugInteractionAnalysis(String drugName) throws ExecutionException, RetryException {

        String query = "假如你现在是一个药学科研人员,请分析药品：" + drugName + "的相互作用（是否跟剂量有关，文本格式）。返回结果合并成一句。并根据分析结果进行打分，打分规则如下：\n" +
                "药物相互作用（单选）\n" +
                "1、3分 无需调整用药剂量；" +
                "2、2分 需要调整用药剂量；" +
                "3、1分 禁止在同一时段使用。\n" +
                "分析结果请用json格式进行回答，其中字段，相互作用的分析结果为drugInteraction，" +
                "单选得分结果为drugInteractionScore。";
        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject drugInteractionAnalysis = new JSONObject();
        drugInteractionAnalysis = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "drugInteractionAnalysis");
        });
        return drugInteractionAnalysis;
    }

    public JSONObject otherAdverseReactionAnalysis(String drugName) throws ExecutionException, RetryException {
        String query = "假如你现在是一个药学科研人员,请分析药品：" + drugName + "的其他不良反应（是否可逆？有无致畸、致癌报道或者特别用药警示内容，文本格式）。返回结果合并成一句。并根据分析结果进行打分，打分规则如下:\n" +
                "其他不良反应（可多选，最高3分。）\n" +
                "1、1分 不良反应均为可逆性；" +
                "2、1分 无致畸、致癌；" +
                "3、1分 无特别用药警示。\n" +
                "分析结果请用json格式进行回答，其中其他不良反应的分析结果为otherAdverseReaction，" +
                "其他不良反应多选得分为otherAdverseReactionScore。";
        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject drugInteractionAnalysis = new JSONObject();
        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "otherAdverseReactionAnalysis");
        });
    }

    private JSONObject guideAdrsInfo_v2(String drugName, String instruction) throws ExecutionException, RetryException {
        JSONObject json = new JSONObject();
        List<String> list = Arrays.asList("不良反应", "禁忌症", "特殊人群", "相互作用");
        StringBuilder content = new StringBuilder();

        for (String str : list) {
            int index = instruction.indexOf(str);
            if (instruction.indexOf(index) > -1) {
                content.append(instruction, index, Math.min((index + 250), instruction.length()));
            }
        }
        String query = "你现在是一个药学科研人员请给出药品：" + drugName + "的以下信息：" +
                "1、中度不良反应（尽可能=详细说明，文本格式）；" +
                "2、重度不良反应（尽可能详细说明，文本格式）；" +
                "3、特殊人群（对特殊人群详细说明每种人群各自的情况并进行编号分类）；" +
                "4、相互作用（是否跟剂量有关，文本格式）；" +
                "5、其他不良反应（是否可逆？有无致畸、致癌报道或者特别用药警示内容，文本格式）。" +
                "请用json格式进行回答，s1为中度不良反应，s2为重度不良反应，s3为特殊人群，s4为药物相互作用，s5为其他不良反应。" +
                "参考资料：" + content;

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject guideAdrsInfo_v2 = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "guideAdrsInfo_v2");
        });

        String s1 = guideAdrsInfo_v2.getString("s1");
        if (StringUtils.isNotBlank(s1)) {
            if (s1.contains("：")) {
                s1 = s1.split("：")[1];
            }
            json.put("中度不良反应", s1);
        } else {
            json.put("中度不良反应", "");
        }
        String s2 = guideAdrsInfo_v2.getString("s2");
        if (StringUtils.isNotBlank(s2)) {
            if (s2.contains("：")) {
                s2 = s2.split("：")[1];
            }
            json.put("重度不良反应", s2);
        } else {
            json.put("重度不良反应", "");
        }
        String s3 = guideAdrsInfo_v2.getString("s3");
        if (StringUtils.isNotBlank(s3)) {
            if (s3.contains("{")) {
                StringBuilder builder = new StringBuilder();
                JSONObject jsonObject1 = guideAdrsInfo_v2.getJSONObject("s3");
                Set<Map.Entry<String, Object>> entries = jsonObject1.entrySet();
                for (Map.Entry<String, Object> entry : entries) {
                    String key = entry.getKey();
                    String value = entry.getValue().toString();
                    builder.append(key).append("：").append(value).append("</br>");
                }
                json.put("特殊人群", builder.toString());
            } else {
                s3 = s3.replaceAll("\n", "</br>");
                json.put("特殊人群", s3);
            }
        } else {
            json.put("特殊人群", "");
        }
        String s4 = guideAdrsInfo_v2.getString("s4");
        if (StringUtils.isNotBlank(s4)) {
            if (s4.contains("：")) {
                s4 = s4.split("：")[1];
            }
            json.put("相互作用", s4);
        } else {
            json.put("相互作用", "");
        }
        String s5 = guideAdrsInfo_v2.getString("s5");
        if (StringUtils.isNotBlank(s5)) {
            if (s5.contains("：")) {
                s5 = s5.split("：")[1];
            }
            json.put("其他不良反应", s5);
        } else {
            json.put("其他不良反应", "");
        }

        return json;
    }

    /**
     * 同类药物安全优势
     *
     * @param drug 药品名称
     * @return 同类药物安全优势
     */
    private JSONObject sameClass(String drug, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请打分：" + drug + "与同类药物相比安全性有优势吗，有的话得4分，没有的话得0分。请用json格式进行回答，score为得分，reason为理由";
        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject sameClass = (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "sameClass");
        });

        return sameClass;
    }

    /**
     * 特殊人群评分
     *
     * @param drugName    药品名称
     * @param instruction 说明书
     * @return 特殊人群评分
     */
    private JSONObject specialCrowd(String drugName, String instruction) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(instruction)) {
            query = "请对" + drugName + "进行评分，结果使用JSON格式返回。" +
                    "1 婴幼儿可用 " +
                    "2 儿童可用 " +
                    "3 孕妇可用或哺乳期妇女可用 " +
                    "4 重度肝功能异常可用 " +
                    "5 重度肾功能异常可用。" +
                    "每项2分，分数可以累加。" +
                    "以下是说明书：" + instruction + "。" +
                    "请用json格式进行回答，score为得分，reason为理由,字段都是文本格式。";
        } else {
            query = "请对" + drugName + "进行评分。" +
                    "1、婴幼儿可用 " +
                    "2、儿童可用 " +
                    "3、孕妇可用或哺乳期妇女可用 " +
                    "4、重度肝功能异常可用 " +
                    "5、重度肾功能异常可用。" +
                    "每项2分，分数可以累加。" +
                    "结果请严格使用json格式进行回答，其中字段score为得分，reason为理由,字段都是文本格式。";
        }


//        String query = "请分别描述"+drugName+"的说明书中的【儿童用药】、【老年用药】、【孕妇及哺乳期妇女用药】、【肝肾功能不全者】具体内容，并按照以下规则进行打分，请给出最终的得分。规则如下：" +
//                "1、婴幼儿可用 " +
//                "2、儿童可用 " +
//                "3、孕妇可用或哺乳期妇女可用 " +
//                "4、重度肝功能异常可用 " +
//                "5、重度肾功能异常可用。" +
//                "每项规则2分，分数可以累加。" +
//                "以下是说明书：" + instruction +"。" +
//                "请用json格式进行回答，其中score为各项得分相加之后的总得分，reason为各项分析理由相加之后的一段话。字段都是文本格式。";
        Retryer retryer = GuavaRetryer.createRetryer();
        String finalQuery = query;
        JSONObject specialCrowd = (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd");
        });
        return specialCrowd;
    }

    /**
     * 通过指南获取药物的有效性评分
     *
     * @param drug     药品名称
     * @param disease  疾病
     * @param guideTxt 指南原文
     * @return 通过指南获取药物的有效性评分
     */
    private JSONObject effective(String drug, String disease, String guideTxt) {
        String query = "你现在是一个医学科学家，请对" + drug + "治疗" + disease + "的有效性评分，" +
                "I 级（强）推荐(44分)；" +
                "指南 II 级（中）推荐，或者多中心 RCT 研提示比现有治疗方案有明显优势（36分）；" +
                "指南 III 级（弱）推荐（30分）;" +
                "专家共识推荐（24分）;" +
                "无以上推荐(10分)单选。" +
                "请直接使用JSON格式进行回答," +
                "score为得分," +
                "disease为所治疗疾病的名称," +
                "reason为具体理由(文本格式至少100字)," +
                "summary为指南中摘录的证据(文本格式至少100字)," +
                "level为指南中的推荐等级(罗马数字)," +
                "advantage为指南中描述的与同类药品相比在临床治疗上方面有哪些优势(至少100字，如果没有则为空字符串),advantageScore为" +
                "effective为指南中描述的临床疗效(至少100字，如果没有则为空字符串)，" +
                "error为判断引用内容是否为指南原文中参考文献的内容，如果是为true否则为false。" +
                "字段都是文本格式。以下为参考指南：" + guideTxt;
        JSONObject jsonObject = new JSONObject();
        int num = 1;
        while (num <= 3) {
            try {
                String result = chat(query);
                log.info(result);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num++;
            log.info("effective开始进行[{}]重试。。。", num);
        }
        if (jsonObject.getString("score") == null) {
            jsonObject.put("score", 0);
        }
        if (jsonObject.getString("reason") == null) {
            jsonObject.put("reason", "");
        }
        if (jsonObject.getString("summary") == null) {
            jsonObject.put("summary", "");
        }
        if (jsonObject.getString("level") == null) {
            jsonObject.put("level", "");
        }
        if (jsonObject.getString("advantage") == null) {
            jsonObject.put("advantage", "");
        }
        if (StrUtil.isNotBlank(jsonObject.getString("advantage"))) {
            jsonObject.put("score", jsonObject.getInteger("score") + 4);
        }
        return jsonObject;
    }

    /**
     * 通过适应症进行评分
     *
     * @param drugName    药品名称
     * @param disease     疾病
     * @param indications
     * @return 通过适应症进行评分
     */
    private JSONObject indicationEeffective(String drugName, String disease, String indications) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(indications)) {
            query = "请你根据提供的药品的适应症资料：" + indications +
                    "。来陈述一下疾病" + disease + "的流行病学。并根据分析结果来判断在临床治疗研究中，药品" + drugName + "在治疗疾病" + disease + "是否为临床必需首选药品？" +
                    "请基于以下评分标准给出最终的评分。（单选）\n" +
                    "1、临床必需，首选药品 得分5分；" +
                    "2、临床必需，次选药品 得分3分；" +
                    "3、可选药品较多 得分1分。\n" +
                    "分析结果请严格采用JSON格式输出。返回的JSON字段包括：" +
                    "1、score（得分）," +
                    "2、process（分析过程）。";
        } else {
            query = "请陈述一下疾病" + disease + "的流行病学，然后判断在临床治疗研究中，药品" + drugName + "在治疗疾病" + disease + "是否为临床必需首选药品？" +
                    "请基于以下评分标准给出最终的评分。（单选）\n" +
                    "1、临床必需，首选药品 得分5分；" +
                    "2、临床必需，次选药品 得分3分；" +
                    "3、可选药品较多 得分1分。\n" +
                    "分析结果请严格采用JSON格式输出。返回的JSON字段包括：" +
                    "1、score（得分）," +
                    "2、process（分析过程）。";
        }
        Retryer retryer = GuavaRetryer.createRetryerAttemptSix();

        String finalQuery = query;
        JSONObject indicationEeffective = (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "indicationEeffective");
        });

        return indicationEeffective;
    }

    /**
     * 通过临床疗效进行评分GPT3.5
     *
     * @param drugName 药品名称
     * @param disease  疾病
     * @return 通过临床疗效进行评分
     */
    private JSONObject clinicalEffect(String drugName, String disease) throws ExecutionException, RetryException {
        String query = "假设你现在是个药学专家，请回答药品：" + drugName + "在治疗疾病" + disease + "的临床疗效方面上，在临床上是经常以主要疗效终点指标评分，还是以次要疗效终点指标评分，" +
                "请基于以下评分标准，针对以上问题的结果，给出相应的评分（单选）：\n" +
                "1、经常以主要疗效终点指标评分得6分；\n" +
                "2、经常以次要疗效终点指标评分得4分。\n" +
                "分析结果请采用JSON格式输出，输出格式为score分数，process分析过程（请在分析过程中注明是否临床必须）。请尽快给出分析。";

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject clinicalEffect = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "clinicalEffect");
        });
        return clinicalEffect;
    }

    private JSONObject literatureAnalysis(String literature, String drug, String disease, String summary) throws ExecutionException, RetryException {
        String query = "假如你现在是一个医学科学家，其中参考文献为《" + literature + "》，部分文献内容为" + summary + "。请你对药品" + drug + "在治疗疾病" + disease + "时的有效性，并通过参考文献进行评分。评分标准如下（单选）：\n" +
                "1、参考文献是系统评价/Meta 分析（大样本、高质量的系统评价/Meta分析得3分，小样本、低质量的系统评价/Meta分析得2分；" +
                "2、参考文献是非 RCT 研究的系统评价/Meta分析得1分）。" +
                "请针对以上问题的分析，返回的结果如下，返回结果请用JSON格式输出" +
                "score为得分(格式为阿拉伯数字)，" +
                "reason为具体打分理由(文本格式至少100字)，" +
                "summary为文献原文中摘录的证据(文本格式至少100字)，" +
                "字段都是文本格式。";

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject literatureAnalysis = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "literatureAnalysis");
        });
        return literatureAnalysis;
    }

    /**
     * 通过指南获取药物的有效性评分GPT3.5
     *
     * @param drug     药品名称
     * @param disease  疾病
     * @param guideTxt 指南原文
     * @return 通过指南获取药物的有效性评分
     */
    private JSONObject guideEffective(String guideName, String drug, String disease, String guideTxt) throws ExecutionException, RetryException {
        String query = "假如你现在是一个医学科学家，其中参考指南为《" + guideName + "》，参考指南中的部分引用内容为：" + guideTxt + "。" +
                "请你先通过指定的参考指南进行分析，再结合提供的引用内容来得出药品" + drug + "在治疗疾病" + disease + "时，该指南的推荐评分，评分标准如下（单选）：\n" +
                "1、推荐等级 I 级（A 级证据得12分，B 级证据得11分，C 级证据及其他得10分）；\n" +
                "2、推荐等级 II 级及以下推荐（A 级证据得9分，B级证据得8分，C级证据及其他得7分）；\n" +
                "3、专家共识推荐（由学会组织基于系统评价发布的共识得6分，学会组织发布的共识得5分，其他得4分。\n" +
                "返回结果请严格使用JSON格式进行回答,其中字段" +
                "score为得分(格式为阿拉伯数字)，" +
                "disease为所治疗疾病的名称，" +
                "reason为具体理由(文本格式至少100字)，" +
                "summary为指南原文中摘录的证据(文本格式至少100字)，" +
//                "level为指南中药品"+drug+"治疗疾病"+disease+"的推荐等级(格式为罗马数字)，" +
                "level为指南中药品" + drug + "治疗疾病" + disease + "的推荐等级(格式为罗马数字)，" +
                "grade为有从参考指南《" + guideName + "》原文内容中实际查询到的" + drug + "在治疗" + disease + "时的推荐等级（格式为罗马数字）（如果没有则为空字符串），" +
                "effective为指南中描述的临床疗效(至少100字，如果没有则为空字符串)，" +
                "error为判断提供的引用内容是否是提供的参考指南中的底部参考文献中的内容，如果是为true否则为false，默认返回false。" +
                "字段都是文本格式。";

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject guideEffective = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "guideEffective");
        });
        return guideEffective;
    }

    private JSONObject guideEffectiveSu(String guideName, String drug, String disease, String guideTxt) throws ExecutionException, RetryException {
        String query = "假如你现在是一个医学科学家，其中参考指南为《" + guideName + "》，参考指南的部分引用内容为：" + guideTxt + "。" +
                "请你先通过指定的参考指南进行分析，再结合提供的引用内容来得出" + drug + "在治疗" + disease + "时，该指南的推荐评分，评分标准如下（单选）：\n" +
                "1、推荐等级 I 级（强）（1A 级证据得12分，1B 级证据得11分，1C 级证据及其他得10分）；" +
                "2、推荐等级 II 级及以下推荐（2A 级证据得9分，2B级证据得8分，2、C级证据及其他得7分）；" +
                "3、专家共识推荐（由学会组织基于系统评价发布的共识得6分，学会组织发布的共识得5分，其他得4分。\n" +
                "返回结果请使用JSON格式进行回答,其中字段" +
                "score为得分(格式为阿拉伯数字)，" +
                "disease为所治疗疾病的名称，" +
                "reason为具体理由(文本格式至少100字)，" +
                "summary为指南原文中摘录的证据(文本格式至少100字)，" +
                "level为指南中" + drug + "治疗" + disease + "的推荐等级(格式为罗马数字)，" +
                "grade为从参考指南《" + guideName + "》原文内容中实际查询到的" + drug + "在治疗" + disease + "时的推荐等级（格式为罗马数字）（如果没有则为空字符串），" +
                "advantage为指南中描述的与同类药品相比在临床治疗上方面有哪些优势(至少100字，如果没有则为空字符串)，" +
                "effective为指南中描述的临床疗效(至少100字，如果没有则为空字符串)，" +
                "error为判断引用内容是否为参考指南原文中参考文献部分中的内容，如果是为true否则为false。" +
//                "字段都是文本格式。以下为参考指南《"+guideName+"》："+guideTxt;
                "字段都是文本格式。以下为参考指南《" + guideName + "》：的引用内容" + guideTxt;

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject guideEffective = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "guideEffective");
        });
        return guideEffective;
    }

    private JSONObject sdySuitScore_sdy(String drugName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        //使用方法/依从性
        String query1 = "";
        if (StrUtil.isNotBlank(drugInfo.getUsageAndDosage())) {
            query1 = "请根据提供的如下资料，按照以下规则进行打分：\n" +
                    "4分 规格、剂型等适宜，使用方便，依从性好\n" +
                    "0分 规格、剂型等适宜欠佳，使用不便，依从性 差\n" +
                    "注意：单选\n" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数，process为分析过程。" +
                    "提供的资料如下：" + drugInfo.getUsageAndDosage();
        } else {
            query1 = "请结合药品说明书 、临床指南、文献、临床试验数据库以及知识库中，" +
                    "分析一下" + drugName + "的规格、剂型等是否适宜，且使用方便，患者依从性好？" +
                    "并根据以下规则进行打分：\n" +
                    "4分 规格、剂型等适宜，使用方便，依从性好\n" +
                    "0分 规格、剂型等适宜欠佳，使用不便，依从性 差\n" +
                    "注意：单选\n" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数，process为分析过程。";
        }
        //贮藏条件
        String query2 = "";
        if (StrUtil.isNotBlank(drugInfo.getStorage())) {
            query2 = "请针对我提供的如下资料：" + drugInfo.getStorage() + "请你以一名专业的资深药店质量管理者的身份，" +
                    "请分析" + drugName + "在平时储藏过程中，是否需要特殊储存条件，并根据以下规则给予一个得分：\n" +
                    "4分：无特殊储存要求\n" +
                    "2分：存储有特殊要求（光线或温度）\n" +
                    "0分：储存特殊要求较多（温度和光线）\n" +
                    "注意：\n" +
                    "特殊储存要求：是指需要冷藏、冷冻、避光、遮光有特殊要求\n" +
                    "冷藏：温度为2-10摄氏度\n" +
                    "冷冻：温度为零下20摄氏度\n" +
                    "单选\n" +
                    "示例：30℃以下保存。视为无特殊储存要求，得4分。\n" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数，process为分析过程。";
        } else {
            query2 = "请你以一名专业的资深药店质量管理者的身份，" +
                    "请分析" + drugName + "在平时储藏过程中，是否需要特殊储存条件，" +
                    "并根据以下规则给予一个得分：\n" +
                    "4分：无特殊储存要求\n" +
                    "2分：存储有特殊要求（光线或温度）\n" +
                    "0分：储存特殊要求较多（温度和光线）\n" +
                    "注意：\n" +
                    "特殊储存要求：是指需要冷藏、冷冻、避光、遮光有特殊要求\n" +
                    "冷藏：温度为2-10摄氏度\n" +
                    "冷冻：温度为零下20摄氏度\n" +
                    "单选\n" +
                    "示例：“30℃以下保存”不属于冷藏或冷冻，也没有提到需要遮光或避光，视为无特殊储存要求，得4分。\n" +
                    "请你严格按照的我的规则来，不要强加你自己的想法\n" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数，process为分析过程。";
        }
        //若为复方制剂，其复方成分及配比是否规范
        String query3 = "请结合药品说明书以及知识库中，" +
                "分析一下" + drugName + "是否为复方制剂，若是复方制剂，" +
                "其复方成分及配比均规范（是否符合β-内酰胺酶抑制剂复方制剂的组成原则）？" +
                "并根据以下评分规则进行打分：\n" +
                "6分 复方成分及配比均规范\n" +
                "0分 未达复方成分及配比均规范\n" +
                "注意：\n" +
                "若药品为非复方制剂，则直接得分，得6分。\n" +
                "复方制剂进行评分时，请明确备注复方制剂的比例。\n" +
                "score中只显示分值即可，不要出现'分'这个字\n" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数，process为分析过程。";

        JSONObject jsonObject = new JSONObject();

        int num1 = 1;
        while (num1 <= 3) {
            try {
                String result = chat(queryAdd + query1);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("使用方法", jsonObject1.getString("score"));
                jsonObject.put("使用方法msg", jsonObject1.getString("process"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num1++;
            log.info("sdySuitScore使用方法/依从性开始进行[{}]重试。。。", num1);
        }
        int num2 = 1;
        while (num2 <= 3) {
            try {
                String result = chat(queryAdd + query2);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("贮藏条件", jsonObject1.getString("score"));
                jsonObject.put("贮藏条件msg", jsonObject1.getString("process"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num2++;
            log.info("sdySuitScore贮藏条件开始进行[{}]重试。。。", num2);
        }
        int num3 = 1;
        while (num3 <= 3) {
            try {
                String result = chat(queryAdd + query3);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("复方成分", jsonObject1.getString("score"));
                jsonObject.put("复方成分msg", jsonObject1.getString("process"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num3++;
            log.info("sdySuitScore复方成分开始进行[{}]重试。。。", num3);
        }

        log.info(jsonObject.toJSONString());
        return jsonObject;
    }


    private JSONObject sdySuitScore(String drugName, String instruction) {
        //使用方法/依从性
        String query1 = "你现在是一个专业药师，请对" + drugName + "的使用方法进行打分，打分标准如下：" +
                "1、规格、剂型等适宜，使用方便，依从性好得4分；" +
                "2、规格、剂型等适宜欠佳，使用不便，依从性差得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的使用方法，字段都是整数格式";
        //贮藏条件
        String query2 = "你现在是一个专业药师，请对" + drugName + "的贮藏条件进行打分，打分标准如下：" +
                "1、无特殊储存要求得4分；" +
                "2、有特殊储存要求比如指温度（冷藏、冷冻）、光线（避光、遮光）等得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的贮藏条件（注意使用文本格式），字段都是整数格式";
        //若为复方制剂，其复方成分及配比是否规范
        String query3 = "你现在是一个专业药师，请对" + drugName + "的复方成分进行打分，打分规则如下：" +
                "1、如果是复方成分及配比均规范得6分；" +
                "2、若为单方制剂，则直接得6分；" +
                "3、其他得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的药品成分（注意使用文本格式），字段都是整数格式";
        //皮试要求
        /*String query4 =   "你现在是一个专业药师，请对"+drugName+"的皮试要求进行打分，打分规则如下：" +
                "1、无皮试要求得4分；" +
                "2、试用前需要皮试得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为说明书中文本格式的皮试要求的说明如果有返回具体信息没有返回空字符串，字段都是整数格式";*/

        String query4 = "你现在是一个专业药师，通常情况下，使用" + drugName + "之前的皮试要求进行打分，打分规则如下：" +
                "1、无皮试要求得4分；" + "2、试用前需要皮试得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为说明书中文本格式的皮试要求的说明如果有返回具体信息没有返回空字符串，字段都是整数格式";
        JSONObject jsonObject = new JSONObject();
        int num1 = 1;
        while (num1 <= 3) {
            try {
                String result = chat(query1);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("使用方法", jsonObject1.getString("score"));
                jsonObject.put("使用方法得分理由", jsonObject1.getString("reason"));
                jsonObject.put("使用方法msg", jsonObject1.getString("msg"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num1++;
            log.info("sdySuitScore使用方法/依从性开始进行[{}]重试。。。", num1);
        }
        int num2 = 1;
        while (num2 <= 3) {
            try {
                String result = chat(query2);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("贮藏条件", jsonObject1.getString("score"));
                jsonObject.put("贮藏条件得分理由", jsonObject1.getString("reason"));
                jsonObject.put("贮藏条件msg", jsonObject1.getString("msg"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num2++;
            log.info("sdySuitScore贮藏条件开始进行[{}]重试。。。", num2);
        }
        int num3 = 1;
        while (num3 <= 3) {
            try {
                String result = chat(query3);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("复方成分", jsonObject1.getString("score"));
                jsonObject.put("复方成分得分理由", jsonObject1.getString("reason"));
                jsonObject.put("复方成分msg", jsonObject1.getString("msg"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num3++;
            log.info("sdySuitScore复方成分开始进行[{}]重试。。。", num3);
        }
        int num4 = 1;
        while (num4 <= 3) {
            try {
                String result = chat(query4);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                JSONObject jsonObject1 = JSONObject.parseObject(result.substring(start, end + 1));
                jsonObject.put("皮试要求", jsonObject1.getString("score"));
                jsonObject.put("皮试要求得分理由", jsonObject1.getString("reason"));
                jsonObject.put("皮试要求msg", jsonObject1.getString("msg"));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num4++;
            log.info("sdySuitScore皮试要求开始进行[{}]重试。。。", num4);
        }

        log.info(jsonObject.toJSONString());
        return jsonObject;
    }

    /***
     * 药学特性
     * @param drugName 药品名称
     * @param disease 疾病名称
     * @param instruction 说明书
     * @return 药学特性
     */
    private JSONObject pharmacy(String drugName, String disease, String instruction) throws ExecutionException, RetryException {
        String query = "假如你现在是一个药学科研人员，请分析出药品：" + drugName + "在治疗疾病" + disease + "时的以下信息：\n" +
                "1、药理作用。" +
                "2、体内过程。" +
                "3、药剂学。" +
                "4、使用方法。" +
                "5、贮藏条件。" +
                "6、有效期。" +
                "返回的结果请严格使用JSON格式返回。返回的JSON字段包括：" +
                "1、pharmacology（药理作用）," +
                "2、disposition（体内过程）," +
                "3、pharmaceutics（药剂学）," +
                "4、usage（使用方法）," +
                "5、storage（贮藏条件）," +
                "6、period（有效性期）,以上字段均为字符串。请快速给出答案。";

        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject pharmacy = (JSONObject) retryer.call(() -> {
            return executeGpt(query, "pharmacy");
        });
        return pharmacy;
    }

    /***
     * 每项药学特性进行评分GPT3.5
     * @param drugName 药品名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject pharmacyScore(String drugName, DrugInfoNew drugInfo, JSONObject pharmacy) throws ExecutionException, RetryException {
        String query = "";
        String pharmacology = drugInfo.getPharmacology();
        if (StrUtil.isNotBlank(pharmacology) && pharmacology.length() > 100) {
            pharmacology = pharmacology.substring(0, 100);
        }
        String pharmacokinetics = drugInfo.getPharmacokinetics();
        if (StrUtil.isNotBlank(pharmacokinetics) && pharmacokinetics.length() > 100) {
            pharmacokinetics = pharmacokinetics.substring(0, 100);
        }
        String usageAndDosage = drugInfo.getUsageAndDosage();
        String storage = drugInfo.getStorage();
        String indate = drugInfo.getIndate();
        if (StrUtil.isBlank(pharmacology) && StrUtil.isBlank(pharmacokinetics) && StrUtil.isBlank(usageAndDosage) && StrUtil.isBlank(storage) && StrUtil.isBlank(indate)) {
            query = "假如你是一个药学专家，请针对我提供的如下资料：1、药理作用：" + pharmacy.getString("pharmacology") +
                    "2、体内过程：" + pharmacy.getString("disposition") +
                    "3、药剂学：" + pharmacy.getString("pharmaceutics") +
                    "4、使用方法：" + pharmacy.getString("usage") +
                    "5、贮藏条件：" + pharmacy.getString("storage") +
                    "6、有效期：" + pharmacy.getString("period") +
                    "来对药品" + drugName + "的5个维度（药理作用、体内过程、药剂学和使用方法、贮藏条件、药品有效期）进行打分。打分规则如下：\n" +
                    "（1）药理作用（单选）：\n" +
                    "5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。\n" +
                    "4分：临床疗效确切，作用机制明确。\n" +
                    "2分：临床疗效尚可，作用机制尚不明确。\n" +
                    "1分：临床疗效一般，作用机制不明确。\n" +
                    "（2）体内过程（单选）：\n" +
                    "5分：体内过程明确，药代动力学参数完整。\n" +
                    "3分：体内过程明确，药代动力学参数不完整。\n" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。\n" +
                    "（3）药剂学和使用方法（符合细则中多项描述时，做加和处理，超过12分记为12分）：\n" +
                    "2分：主要成分与辅料均明确。\n" +
                    "1分：主要成分或辅料明确。\n" +
                    "2分：规格与包装均适宜临床应用/剂量调整。\n" +
                    "1分：规格或包装适宜临床应用/剂量调整。\n" +
                    "2分：剂型适宜，如口服/吸入/外用制剂。\n" +
                    "1.5分：剂型需适应特定给药途径，如皮下/肌内注射剂。\n" +
                    "1分：剂型需适应特定给药途径，如静脉滴注/静脉注射剂。\n" +
                    "2分：给药剂量固定。\n" +
                    "1.5分：使用过程中需调整给药剂量。\n" +
                    "1分：根据体质量或体表面积计算用药剂量。\n" +
                    "2分：给药频次适宜，如≤1次·d^-1。\n" +
                    "1.5分：给药频次适宜，如2次·d^-1。\n" +
                    "1分：给药频次适宜，如≥3次·d^-1。\n" +
                    "2分：使用方便，无需辅助，可自行给药。\n" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。\n" +
                    "1分：使用较为繁琐，需医务人员给药。\n" +
                    "（4）贮藏条件（单选）：\n" +
                    "3分：常温贮藏。\n" +
                    "2分：阴凉贮藏。\n" +
                    "1分：冷藏/冷冻贮藏。\n" +
                    "1分：无需遮光/避光。\n" +
                    "（5）药品有效期（单选）：\n" +
                    "2分：有效期大于等于60个月。\n" +
                    "1.5分：有效期大于等于36个月并且小于60个月。\n" +
                    "1分：有效期大于等于24个月并且小于36个月。\n" +
                    "0.5分：有效期大于等于12个月并且24个月。\n" +
                    "0.25分：有效期小于12个月。\n" +
                    "分析结果请严格采用JSON格式返回。返回的JSON字段包括：" +
                    "1、pharmacologyScore（药理作用得分），" +
                    "2、pharmacokineticsScore（体内过程得分），" +
                    "3、usageAndDosageScore（药剂学与使用方法得分），" +
                    "4、storageScore（贮藏条件得分），" +
                    "5、indateScore（有效期得分）。得分返回结果为数字，请务必给出得分。";
        } else {
            query = "假如你是一个药学专家，请针对我提供的如下资料：1、药理作用：" + (StrUtil.isNotBlank(pharmacology) ? pharmacology : pharmacy.getString("pharmacology")) +
                    "2、体内过程：" + (StrUtil.isNotBlank(pharmacokinetics) ? pharmacokinetics : pharmacy.getString("disposition")) +
                    "3、药剂学：" + (StrUtil.isNotBlank(usageAndDosage) ? usageAndDosage : pharmacy.getString("pharmaceutics")) +
                    "4、使用方法：" + (StrUtil.isNotBlank(usageAndDosage) ? usageAndDosage : pharmacy.getString("usage")) +
                    "5、贮藏条件：" + (StrUtil.isNotBlank(storage) ? storage : pharmacy.getString("storage")) +
                    "6、有效期：" + (StrUtil.isNotBlank(indate) ? indate : pharmacy.getString("period")) +
                    "。根据提供的资料来对药品" + drugName + "的5个维度（药理作用、体内过程、药剂学和使用方法、贮藏条件、药品有效期）进行打分。打分规则如下：\n" +
                    "（1）药理作用（单选）：\n" +
                    "5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。\n" +
                    "4分：临床疗效确切，作用机制明确。\n" +
                    "2分：临床疗效尚可，作用机制尚不明确。\n" +
                    "1分：临床疗效一般，作用机制不明确。\n" +
                    "（2）体内过程（单选）：\n" +
                    "5分：体内过程明确，药代动力学参数完整。\n" +
                    "3分：体内过程明确，药代动力学参数不完整。\n" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。\n" +
                    "（3）药剂学和使用方法（符合细则中多项描述时，做加和处理，超过12分记为12分）：\n" +
                    "2分：主要成分与辅料均明确。\n" +
                    "1分：主要成分或辅料明确。\n" +
                    "2分：规格与包装均适宜临床应用/剂量调整。\n" +
                    "1分：规格或包装适宜临床应用/剂量调整。\n" +
                    "2分：剂型适宜，如口服/吸入/外用制剂。\n" +
                    "1.5分：剂型需适应特定给药途径，如皮下/肌内注射剂。\n" +
                    "1分：剂型需适应特定给药途径，如静脉滴注/静脉注射剂。\n" +
                    "2分：给药剂量固定。\n" +
                    "1.5分：使用过程中需调整给药剂量。\n" +
                    "1分：根据体质量或体表面积计算用药剂量。\n" +
                    "2分：给药频次适宜，如≤1次·d^-1。\n" +
                    "1.5分：给药频次适宜，如2次·d^-1。\n" +
                    "1分：给药频次适宜，如≥3次·d^-1。\n" +
                    "2分：使用方便，无需辅助，可自行给药。\n" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。\n" +
                    "1分：使用较为繁琐，需医务人员给药。\n" +
                    "（4）贮藏条件（单选）：\n" +
                    "3分：常温贮藏。\n" +
                    "2分：阴凉贮藏。\n" +
                    "1分：冷藏/冷冻贮藏。\n" +
                    "1分：无需遮光/避光。\n" +
                    "（5）药品有效期（单选）：\n" +
                    "2分：有效期≥60个月。\n" +
                    "1.5分：有效期≥36个月，＜60个月。\n" +
                    "1分：有效期≥24个月，＜36个月。\n" +
                    "0.5分：有效期≥12个月，＜24个月。\n" +
                    "0.25分：有效期＜12个月。\n" +
                    "分析结果请严格采用JSON格式返回。返回的JSON字段包括：" +
                    "1、pharmacologyScore（药理作用得分），" +
                    "2、pharmacokineticsScore（体内过程得分），" +
                    "3、usageAndDosageScore（药剂学与使用方法得分），" +
                    "4、storageScore（贮藏条件得分），" +
                    "5、indateScore（有效期得分）。得分返回结果为数字，请务必给出得分。";
        }
        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "pharmacyScore");
        });
    }

    /**
     * 判断药品的生产企业情况 使用文心一言进行判断
     *
     * @param enterpirceName 厂家名称
     * @return 生产企业情况
     */
    public JSONObject guideWenEnterprise(String enterpirceName) {
        String query = "问题1：介绍" + enterpirceName + "并给出其在制药企业或工信部医药工业百强榜企业中的排名情况。" +
                "问题2：请基于以下评分标准，针对刚才提供的结果，给出相应的评分。" +
                "（单选）1分 世界销量前50的制药企业1-10名；" +
                "0.8分 世界销量前50的制药企业11-20名；" +
                "0.6分 世界销量前50的制药企业21-30名；" +
                "0.4分 世界销量前50的制药企业31-40名；" +
                "0.2分 世界销量前50的制药企业41-50名；" +
                "1分 工信部医药工业百强榜企业1-20名；" +
                "0.8分 工信部医药工业百强榜企业21-40名；" +
                "0.6分 工信部医药工业百强榜企业41-60名；" +
                "0.4分 工信部医药工业百强榜企业61-80名；" +
                "0.2分 工信部医药工业百强榜企业81-100名。" +
                "分析结果采用JSON格式返回，score为分数，process为分析过程，info为问题一答案。";
        //String query =  "问题1：介绍"+enterpirceName+"并给出其在制药企业或工信部医药工业百强榜企业中的排名情况。";
        JSONObject jsonObject = new JSONObject();
        int num = 1;
        while (num <= 3) {
            try {
                String result = wenChat(query);
                log.info(result);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
                break;
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            num++;
            log.info("guideWenEnterprise开始进行[{}]重试。。。", num);
        }
        if (jsonObject.getString("score") == null) {
            jsonObject.put("score", 0);
        }
        if (jsonObject.getString("process") == null) {
            jsonObject.put("process", "");
        }
        if (jsonObject.getString("info") == null) {
            jsonObject.put("info", "");
        }
        return jsonObject;
    }


    private JSONObject executeGpt(String query, String name) {
        JSONObject jsonObject = new JSONObject();
        String result = youyideyi(query);
        log.info(name + "进行了分析");
        log.info("GPT分析的问题是:{}", query);
        log.info("----经过GPT分析出来的结果是{}", result);
        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
        return jsonObject;
    }

    private JSONObject executeGptwen(String query, String name) {
        JSONObject jsonObject = new JSONObject();
        String result = wenChat(query);
        log.info(name + "进行了分析");
        log.info("GPT分析的问题是:{}", query);
        log.info("----经过GPT分析出来的结果是{}", result);
        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
        return jsonObject;
    }

    private void addProcess(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(msg);
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    // ##############################最新一版本的prompt##################################


    // ##############################pc端##################################

    /***
     * 药学特性--药理作用分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject pharmacology(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getPharmacology())) {
            query = "请针对我提供的说明书中药理作用的资料：" + drugInfo.getPharmacology() + "\n" +
                    "请根据以下评分规则，针对给出的药理作用结果进行打分。" +
                    "注意：请单选。5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。 " +
                    "4分：临床疗效确切，作用机制明确。 " +
                    "2分：临床疗效尚可，作用机制尚不明确。 " +
                    "1分：临床疗效一般，作用机制不明确。" +
//                    "注意：输出结果均应为中文字符，且不用出现score和process。" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：" +
                    "score为分数（只能是阿拉伯数字组成），process为分析过程。";
        } else {
            query = "请你以一名专业的药学科研人员的身份，分析" + drugName + "在治疗" + disease + "的药理作用如何。再根据以下评分规则，针对给出的药理作用结果进行打分。" +
                    "注意，请单选。5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。 " +
                    "4分：临床疗效确切，作用机制明确。 " +
                    "2分：临床疗效尚可，作用机制尚不明确。 " +
                    "1分：临床疗效一般，作用机制不明确。" +
//                    "注意：输出结果均应为中文字符，且不用出现score和process。" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：" +
                    "score为分数（只能是阿拉伯数字组成），process为分析过程（分析过程中需要包含药理作用具体是什么，然后再给出分析结果）。";
        }
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "pharmacology");
        });
    }

    /***
     * 药学特性--药理作用分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject pharmacokinetics(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getPharmacokinetics())) {
            query = "请针对我提供的说明书中药理作用的资料：" + drugInfo.getPharmacokinetics() + "\n" +
                    "请根据以下评分规则，针对给出的说明书中药代动力学内容进行打分。" +
                    "请单选（并且最终得分只能为5或3或1，不得自创分值）。" +
                    "5分：体内过程明确，药代动力学参数完整。" +
                    "3分：体内过程明确，药代动力学参数不完整。" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process分析过程。";
        } else {
            query = "请你以一名专业的药学科研人员的身份，分析" + drugName + "在治疗" + disease + "的体内过程（药代动力学）如何。" +
                    "再根据以下评分规则，针对给出的体内过程（药代动力学）结果进行打分。" +
                    "分析过程中需要包含体内过程或药代动力学具体是什么，然后再给出分析结果。" +
                    "注意，请单选（并且最终得分只能为5或3或1，不得自创分值）。" +
                    "5分：体内过程明确，药代动力学参数完整。" +
                    "3分：体内过程明确，药代动力学参数不完整。" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process分析过程。";
        }
        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "pharmacokinetics");
        });
    }

    /***
     * 药学特性--药剂学和使用方法分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject usageAndDosage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getUsageAndDosage())) {
            query = "请根据以下提供的说明书中相关内容，分别分析以下内容：" +
                    "请分析一下" + drugName + "的主要成分与辅料是否明确，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：主要成分与辅料均明确。" +
                    "1分：主要成分或辅料明确。" +
                    "请分析一下" + drugName + "的规格与包装是否使用临床使用，在临床中是否需要针对不同人群或疾病需要进行剂量调整，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：规格与包装均适宜临床应用/剂量调整。" +
                    "1分：规格或包装适宜临床应用/剂量调整。" +
                    "请分析一下" + drugName + "的剂型是什么，" +
                    "并根据以下评分规则给予一个得分（注意：若药品的剂型为多种剂型时，取最高分即可）：" +
                    "2分：剂型适宜，如口服/吸入/外用制剂。" +
                    "1.5分：剂型需适应特定给药途径，如皮下/肌内注射剂。" +
                    "1分：剂型需适应特定给药途径，如静脉滴注/静脉注射剂。\n" +
                    "请分析一下" + drugName + "在治疗" + disease + "时，是否需要调整给药剂量或者根据体重或体表面积计算给药剂量，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：给药剂量固定。" +
                    "1.5分：使用过程中需调整给药剂量。" +
                    "1分：根据体质量或体表面积计算用药剂量。" +
                    "请分析一下" + drugName + "在治疗" + disease + "时的给药频次如何，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：给药频次适宜，如≤1次·d^-1。" +
                    "1.5分：给药频次适宜，如2次·d^-1。" +
                    "1分：给药频次适宜，如≥3次·d^-1。" +
                    "请分析一下" + drugName + "在治疗过程中使用是否便利，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：使用方便，无需辅助，可自行给药。" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                    "1分：使用较为繁琐，需医务人员给药。" +
                    "请注意，最终的分数为上面各分数的加和，最高为12分，超出12分时输出为12即可。" +
                    "process中不要出现[{'评分项': 和'}]这样的字眼，直接显示分析结果即可。" +
                    "每一个问题分析结束后，请换行展示另一个问题的结果" +
                    "分析结果请严格采用JSON格式返回（整体是一个json）。返回的JSON字段包括：" +
//                    "输出格式为score分数（分数为上面各分数的加和），process分析过程。" +
                    "其中主要成分与辅料的得分为scoreA（只能是阿拉伯数字组成），分析过程为processA；" +
                    "规格与包装的得分为scoreB（只能是阿拉伯数字组成），分析过程为processB；" +
                    "剂型的得分为scoreC（只能是阿拉伯数字组成），分析过程为processC；" +
                    "给药剂量的得分为scoreD（只能是阿拉伯数字组成），分析过程为processD；" +
                    "给药频次的得分为scoreD（只能是阿拉伯数字组成），分析过程为processE；" +
                    "使用方便的得分为scoreF（只能是阿拉伯数字组成），分析过程为processF。" +
                    "提供的说明书中相关资料如下：" + drugInfo.getUsageAndDosage() + "；" + drugInfo.getIngredient() + "；" + drugInfo.getPack() + "；" + drugInfo.getSpecificationsIns();
        } else {
            query = "请你以一名专业的药学科研人员的身份，请分别分析" + drugName + "的主要成分与辅料是否明确，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：主要成分与辅料均明确。" +
                    "1分：主要成分或辅料明确。" +
                    "请分析一下" + drugName + "的规格与包装是否使用临床使用，在临床中是否需要针对不同人群或疾病需要进行剂量调整，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：规格与包装均适宜临床应用/剂量调整。" +
                    "1分：规格或包装适宜临床应用/剂量调整。" +
                    "请分析一下" + drugName + "的剂型是什么，" +
                    "并根据以下评分规则给予一个得分（注意：若药品的剂型为多种剂型时，取最高分即可）：" +
                    "2分：剂型适宜，如口服/吸入/外用制剂。" +
                    "1.5分：剂型需适应特定给药途径，如皮下/肌内注射剂。" +
                    "1分：剂型需适应特定给药途径，如静脉滴注/静脉注射剂。" +
                    "请分析一下" + drugName + "在治疗" + disease + "时，是否需要调整给药剂量或者根据体重或体表面积计算给药剂量，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：给药剂量固定。" +
                    "1.5分：使用过程中需调整给药剂量。" +
                    "1分：根据体质量或体表面积计算用药剂量。" +
                    "请分析一下" + drugName + "在治疗" + disease + "时的给药频次如何，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：给药频次适宜，如≤1次·d^-1。" +
                    "1.5分：给药频次适宜，如2次·d^-1。" +
                    "1分：给药频次适宜，如≥3次·d^-1。" +
                    "请分析一下" + drugName + "在治疗过程中使用是否便利，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：使用方便，无需辅助，可自行给药。" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                    "1分：使用较为繁琐，需医务人员给药。" +
                    "请注意，最终的分数为上面各分数的加和，最高为12分，超出12分时输出为12即可。" +
                    "process中不要出现[{'评分项': 和'}]这样的字眼，直接显示分析结果即可。" +
                    "每一个问题分析结束后，请换行展示另一个问题的结果" +
                    "分析结果请严格采用JSON格式返回。（整体是一个json）" +
                    "返回的JSON字段包括：" +
//                    "输出格式为score分数，process分析过程。" +
                    "其中主要成分与辅料的得分为scoreA（只能是阿拉伯数字组成），分析过程为processA；" +
                    "规格与包装的得分为scoreB（只能是阿拉伯数字组成），分析过程为processB；" +
                    "剂型的得分为scoreC（只能是阿拉伯数字组成），分析过程为processC；" +
                    "给药剂量的得分为scoreD（只能是阿拉伯数字组成），分析过程为processD；" +
                    "给药频次的得分为scoreD（只能是阿拉伯数字组成），分析过程为processE；" +
                    "使用方便的得分为scoreF（只能是阿拉伯数字组成），分析过程为processF。";
        }
        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "usageAndDosage");
        });
    }

    /***
     * 药学特性--贮藏条件分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject storage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getStorage())) {
            query = "常温、阴凉、冷藏的定义如下：" +
                    "温度值在8.001-20℃时，视为阴凉处。" +
                    " 2-8℃视为冷藏。" +
                    " 温度值在10-30℃时，视为常温。说明书贮藏条件中没有提到温度，视为室温。比如：30℃以下保存，视为常温贮藏。" +
                    " 注意：" +
                    " 若储藏条件中没有提到“遮光”或“避光”这样的字眼，或者明确说明无需遮光或无需避光，请额外再加一分；" +
                    " 分析结果请严格采用JSON格式返回。" +
                    "请针对我提供的说明书中相关资料：" + drugInfo.getStorage() + "\n" +
                    "分析" + drugName + "在储藏过程中的要求，" +
                    "根据以上定义、注意事项以及以下规则给出一个最终得分：" +
                    "3分：常温贮藏，且需要遮光/避光" +
                    "2分：阴凉贮藏，且需要遮光/避光" +
                    "1分：冷藏/冷冻贮藏，且需要遮光/避光" +
                    "4分：常温贮藏，不需要遮光/避光" +
                    "3分：阴凉贮藏，且不需要遮光/避光" +
                    "2分：冷藏/冷冻贮藏，且不需要遮光/避光" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        } else {
            query = "常温、阴凉、冷藏的定义如下：" +
                    "温度值在8.001-20℃时，视为阴凉处。" +
                    " 2-8℃视为冷藏。" +
                    " 温度值在10-30℃时，视为常温。比如：30℃以下保存，视为常温贮藏。" +
                    " 注意：" +
                    " 若储藏条件中没有提到“遮光”或“避光”这样的字眼，或者明确说明无需遮光或无需避光，请额外再加一分；" +
                    " 分析结果请严格采用JSON格式返回。" +
                    "分析" + drugName + "在储藏过程中的要求，" +
                    "根据以上定义、注意事项以及以下规则给出一个最终得分：" +
                    "3分：常温贮藏，且需要遮光/避光" +
                    "2分：阴凉贮藏，且需要遮光/避光" +
                    "1分：冷藏/冷冻贮藏，且需要遮光/避光" +
                    "4分：常温贮藏，不需要遮光/避光" +
                    "3分：阴凉贮藏，且不需要遮光/避光" +
                    "2分：冷藏/冷冻贮藏，且不需要遮光/避光" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        }
        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "storage");
        });
    }

    /***
     * 药学特性--有效期分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    private JSONObject indate(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getIndate())) {
            query = "请针对我提供的如下资料：" + drugInfo.getIndate() + "\n" +
                    "，若以上资料中是’**个‘而没有真正显示时间，则按照’**个月‘计算"+
                    "请根据以下规则给予一个得分(若有两个有效期，以有效期较短为准，只进行一次评分)：\n" +
                    "2分：有效期≥60个月。\n" +
                    "1.5分：有效期≥36个月，＜60个月。\n" +
                    "1分：有效期≥24个月，＜36个月。\n" +
                    "0.5分：有效期≥12个月，＜24个月。12个月也算0.5分。\n" +
                    "0.25分：有效期＜12个月。\n" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        } else {
            query = "请分析" + drugName + "的有效期是多长时间，并根据以下规则给予一个得分(若有两个有效期，以有效期较短为准，只进行一次评分)：\n" +
                    "2分：有效期≥60个月。\n" +
                    "1.5分：有效期≥36个月，＜60个月。\n" +
                    "1分：有效期≥24个月，＜36个月。\n" +
                    "0.5分：有效期≥12个月，＜24个月。12个月也算0.5分。\n" +
                    "0.25分：有效期＜12个月。\n" +
                    "注意：'score' 请不要给出 '无法给出具体得分' 这样的话，若因无法给出药品的具体有效期数据而无法打分，" +
                    "请根据药品的平均有效期，最终得分请给出一个最终得分；或者直接给出最低分0.25。" +
                    "分析结果请严格采用JSON格式返回。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        }
        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "indate");
        });
    }

    /***
     * 有效性--适应症
     * @param drugToModel
     */
    private JSONObject indication(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String   doc = xiaoling(drugToModel.getDisease(), "请分析一下在临床研究中，在治疗" +
                drugToModel.getDisease() + "的药品除了"+drugToModel.getDrugName()+"的药品除了"+drugToModel.getDrugName()+"还有哪些？返回结果请这样回答：治疗"+drugToModel.getDisease()+"的药品除了"+drugToModel.getDrugName()+"还有哪些？返回结果请这样回答：治疗"+drugToModel.getDisease()+"除了"+drugToModel.getDrugName()+"还有...（总结一句话返回）");
        drugToModel.setXiaoling(doc);
        Retryer retryer = GuavaRetryer.createRetryer();
        String queryAdd = getDrugAddPrompt(drugToModel);
        String query =  replacePrompt(getPrompt(PromptEnum.INSTRUCTION),drugToModel);
        String finalQuery = queryAdd + query;
        JSONObject indication1 = (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "indication");
        });
        indication1.put("process", doc + indication1.getString("process"));
        return indication1;
    }

    /***
     * 有效性--指南
     * @Param drugToModel
     * @param pdf_txt 原文内容
     * @param zdz  制定者
     * @param title  文章标题
     */
    private JSONObject guide(DrugToModel drugToModel, String pdf_txt, String zdz, String title, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String queryAdd = getDrugAddPrompt(drugToModel);
        String query = "请根据" + zdz + "发布的《" + title + "》中的原文内容:'" + pdf_txt + "'" +
                "汇总出一段" + drugToModel.getDrugName() + "治疗" + drugToModel.getDisease() + "的有效性相关结论，并根据以下评分规则给出最高评分：" +
                "1、诊疗规范/临床路径、国家卫生行政机构发布共识，得12分；\n" +
                "2、管理办法等、指南Ⅰ级推荐，A级证据，得12分；\n" +
                "3、管理办法等、指南Ⅰ级推荐，B 级证据得11分；\n" +
                "4、管理办法等、指南Ⅰ级推荐，C级证据及其他得10分；\n" +
                "5、指南Ⅱ据及以下推荐，A级证据，得9分；\n" +
                "6、指南Ⅱ据及以下推荐，B级证据得8分；\n" +
                "7、指南Ⅱ据及以下推荐，C级证据及其他得7分；\n" +
                "8、由学会组织基于系统评价发布的专家共识推荐，得6分；\n" +
                "9、由学会组织发布的专家共识推荐，得5分；\n" +
                "10、其他专家共识推荐，得4分；\n" +
                "最低打分为4分"+
                "注意：" +
                "（1）分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "（2）当指南共识标题中出现“诊疗规范”或者“临床路径”时，请给予12分；" +
                "（3）当指南共识的发布者制定者中出现“国家”时，请给予12分；" +
                "（4）当指南共识标题中，或者发布者/制定者中出现“专家共识”时，请给予6分；" +
                "（5）只有当指南共识原文中明确提出推荐等级时，才可根据评分标准进行打分。不要自己总结；" +
                "分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "结论性话术全部以中文结果输出，不用出现小标题，类似XX治疗XX有效性相关结论：等字眼。" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为根据原文内容汇总出成一段总结性的话。";

        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "guideOrLiterature");
        });
    }

    /***
     * 有效性--文献
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param
     * @param
     * @param title  文章标题
     */
    private JSONObject literature(String drugName, String disease, String summary, String title, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请根据《" + title + "》中的原文内容:'" + summary + "'" +
                "汇总出一段" + drugName + "治疗" + disease + "的有效性相关结论，提取出其中的试验组与对照组分别是什么，纳入的样本量分别是多少？此研究是否属于RCT相关的Meta分析？汇总并根据以下评分规则给出最高评分：" +
                "1、大样本、高质量的系统评价/Meta 分析，得3分；\n" +
                "2、小样本、低质量的系统评价/Meta 分析，得2分；\n" +
                "3、非 RCT 研究的系统评价/Meta 分析，得1分。\n" +
                "注意：分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "结论性话术全部以中文结果输出，不用出现小标题，类似XX治疗XX有效性相关结论：等字眼。" +
                "分析结果请严格采用JSON格式返回。" +
                "若无样本量相关数据，输出内容为空即可。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程以及汇总字段。";

        //GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "guideOrLiterature");
        });
    }

    /***
     * 有效性--临床疗效
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject clinical(String drugName, String disease, DrugToModel drugToModel) throws ExecutionException, RetryException {
        String queryAdd = getDrugAddPrompt(drugToModel);
        String query = "假设你现在是个临床试验研究员，请回答药品：" + drugName + "在治疗" + disease + "期的临床疗效方面上，" +
                "经常以哪些结局指标作为观察疗效的指标（请分别罗列主要疗效终点指标以及次要疗效终点指标）" +
                "请基于以下评分标准，针对以上问题的结果，给出相应的评分（可以多选，如果既有主要指标又有次要指标，就是最高分10分）：\n" +
                "1、经常以主要疗效终点指标评分得6分；\n" +
                "2、经常以次要疗效终点指标评分得4分。\n" +
                "分析结果请采用JSON格式输出，score为分数（只能是阿拉伯数字组成），process为分析过程字段。";

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "clinical");
        });
    }

    /***
     * 安全性--重度和中度不良反应
     * @param drugToModel
     */
    private JSONObject adverseReaction(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String doc = xiaoling(drugToModel.getDrugName(), "请问" + drugToModel.getDrugName() + "的重度和中度不良反应分别是什么，以及其发生率，若资料里没有发生率，也尽量依照你所知道的进行提供");
        drugToModel.setXiaoling(doc);
//        if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
        String finalQuery = getDrugAddPrompt(drugToModel)+replacePrompt(getPrompt(PromptEnum.ADVERSE_REACTION),drugToModel);
        Retryer retryer = GuavaRetryer.createRetryer();
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "adverseReaction");
        });
    }

    /***
     * 安全性--特殊人群-妇女
     */
    private JSONObject specialCrowd_pregnantWomen(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String query = "";
        String queryAdd = getDrugAddPrompt(drugToModel);
        if (StrUtil.isNotBlank(drugToModel.getPregnantWomen()) || StringUtils.isNotEmpty(drugToModel.getPregnantWomen())) {
            query = replacePrompt(getPrompt(PromptEnum.PREGNANT_WOMEN_1), drugToModel);
        } else {
            drugToModel.setXiaoling( xiaoling(drugToModel.getDrugName(), "妊娠期妇女使用" + drugToModel.getDrugName() + "需要注意什么，是否可用"));
            query = replacePrompt(getPrompt(PromptEnum.PREGNANT_WOMEN_2), drugToModel);
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_pregnantWomen");
        });
    }

    /***
     * 安全性--特殊人群-儿童
     */
    private JSONObject specialCrowd_childrenMedicine(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String queryAdd = getDrugAddPrompt(drugToModel);
        if (StrUtil.isEmpty(drugToModel.getChildrenMedicine())) {
            drugToModel.setChildrenMedicine(xiaoling(drugToModel.getDrugName(), "关于儿童是否可以使用，以及使用的注意事项方面，" + drugToModel.getDrugName() + "是否可用，请根据已有资料或者你所知道的详细回答"));
        }
        Retryer retryer = GuavaRetryer.createRetryer();
        String query = replacePrompt(getPrompt(PromptEnum.CHILDREN_MEDICINE), drugToModel);
        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd+query, "specialCrowd_childrenMedicine");
        });
    }

    /***
     * 安全性--特殊人群- 老人
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_geriatricMedicine(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String queryAdd = getDrugAddPrompt(drugToModel);
        if (StringUtils.isEmpty(drugToModel.getGeriatricMedicine())) {
            String doc = xiaoling(drugToModel.getDrugName(), "在使用" + drugToModel.getDrugName() + "时，老年人是否可用，以及使用的注意事项，请结合已有材料详细或者你知道的数据回答");
        drugToModel.setGeriatricMedicine(doc);
        }

        //todo 需要修改
        String query = replacePrompt(getPrompt(PromptEnum.CHILDREN_MEDICINE), drugToModel);

        Retryer retryer = GuavaRetryer.createRetryer();


        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd+query, "specialCrowd_geriatricMedicine");
        });
    }

    /***
     * 安全性--特殊人群-肝肾

     */
    private JSONObject specialCrowd_liverKidney(DrugToModel drugToModel) throws ExecutionException, RetryException {
        String query = "";
        String queryAdd = getDrugAddPrompt(drugToModel);
        //todo 需要修改
        query = replacePrompt(getPrompt(PromptEnum.CHILDREN_MEDICINE), drugToModel);
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGptwen(finalQuery, "specialCrowd_liverKidney");
        });
    }

    /***
     * 安全性--药物相互作用
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject drugInteraction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        if (StrUtil.isNotBlank(drugInfo.getDrugInteraction())) {
            query = "请结合以下药物相互作用相关内容，对" + drugName + "的安全性进行打分，打分规则如下：\n" +
                    "无需调整用药剂量 3分\n" +
                    "需要调整用药剂量 1分\n" +
                    "禁止在同一时段使用 1分\n" +
                    "注意：'Score' 单选，当结果符合多条评分规则时，取最高分\n" +
                    "如果提供的数据中出现“无需调整剂量”等词语时，给最高分3分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。\n" +
                    "请针对我提供的如下资料" + drugInfo.getDrugInteraction();
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "的药物相互作用相关内容，并根据给出的分析结果内容进行打分，打分规则如下：\n" +
                    "无需调整用药剂量 3分\n" +
                    "需要调整用药剂量 1分\n" +
                    "禁止在同一时段使用 1分\n" +
                    "注意：'Score'单选，当结果符合多条评分规则时，取最高分\n" +
                    "如果提供的数据中出现“无需调整剂量”等词语时，给最高分3分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "drugInteraction");
        });
    }

    /***
     * 安全性--其他不良反应
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject otherAdverseReaction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请分析临床指南、文献、药品说明书以及相关政策内容中，" + drugName + "的不良反应是否均可逆；有无致、畸致癌风险；有无特别用药警示，" +
                "并根据给出的分析结果内容进行打分，打分规则如下：\n" +
                "不良反应均为可逆性 1分\n" +
                "无致畸、致癌 1分\n" +
                "无特别用药警示 1分\n" +
                "注意：可多选，最高为3分，总得分不得超过3分\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段（此分析过程字段格式为中文类型String）。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "otherAdverseReaction");
        });
    }


    /**
     * 安全性--药物相互作用
     * 判断当前药品的原研/参比/一致性评价情况
     *
     * @param drugName 药品名称
     * @return 当前药品的药品情况得分，及 原研/参比/一致性 所属情况
     */
    private JSONObject guideDrugSituation(String drugName, String enterpirceName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请分析药品注册信息、药品评审中信、国家药品监督管理局等官方网站，以及知识库中，" +
                "判断下" + enterpirceName + "生产的" + drugName + "属于原研药品，还是属于仿制药的参比制剂，还是属于通过一致性评价的仿制药，" +
                "并根据分析结果内容进行打分，打分规则如下：\n" +
                "原研药品 1分\n" +
                "参比制剂 1分\n" +
                "通过一致性评价 0.5分\n" +
                "注意：'Score' 单选，最高为1分\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "guideDrugSituation");
        });
    }


    /**
     * 判断药品的生产企业情况
     *
     * @param enterpirceName 厂家名称
     * @return 生产企业情况
     */
    private JSONObject guideEnterprise(String enterpirceName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请根据知识库分析" + enterpirceName + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况，" +
                "并根据分析结果内容进行打分，打分规则如下：\n" +
                "世界销量前50的制药企业的排名在1-10名  1分\n" +
                "世界销量前50的制药企业的排名在11-20名  0.8分\n" +
                "世界销量前50的制药企业的排名在21-30名  0.6分\n" +
                "世界销量前50的制药企业的排名在31-40名  0.4分\n" +
                "世界销量前50的制药企业的排名在41-50名  0.2分\n" +
                "世界销量前50的制药企业中无排名 0分\n" +
                "工信部医药工业百强榜企业1-10名  1分\n" +
                "工信部医药工业百强榜企业21-40名  0.8分\n" +
                "工信部医药工业百强榜企业41-60名  0.6分\n" +
                "工信部医药工业百强榜企业61-80名  0.4分\n" +
                "工信部医药工业百强榜企业81-100名  0.2分\n" +
                "工信部医药工业百强榜企业中无排名 0分\n" +
                "注意：'Score'单选（最高为1分）。当结果符合规则中的多条时，取最高的得分结果即可\n" +
                "未知排名情况时，说明情况后，给最低分0分。\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        Retryer retryer = GuavaRetryer.createRetryer();

        JSONObject guideEnterprise = (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "guideEnterprise");
        });
        return guideEnterprise;
    }

    /**
     * 全球使用情况
     *
     * @param drugName 药品名称
     * @return 全球使用情况
     */
    private JSONObject guideCountry(String drugName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请根据药品注册信息、药品评审中信、国家药品监督管理局等官方网站，" +
                "以及知识库，分析" + drugName + "在中国、美国、欧洲、日本四国的上市/获批情况，是否在国内及国外均有销售，" +
                "并根据分析结果内容进行打分，打分规则如下：\n" +
                "中国、美国、欧洲、日本均已上市  1分\n" +
                "国内外均有销售  0.5分\n" +
                "注意：'Score' 单选（最高为1分）。当结果符合规则中的多条时，取最高的得分结果即可\n" +
                "未知情况时，说明情况后，给最低分0分。\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程（必须要有内容）。";
        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "guideCountry");
        });
    }


    // ##############################APP端##################################

    /***
     * 有效性--指南
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param pdf_txt 原文内容
     */
    private JSONObject guide_sdy(String drugName, String disease, String pdf_txt, String title, String zdz, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请根据" + zdz + "发布的《" + title + "》中的原文内容:'" + pdf_txt + "'" +
                "汇总出一段" + drugName + "治疗" + disease + "的有效性相关结论，并根据以下评分规则给出最高评分：" +
                "《诊疗规范》中围术期预防用抗菌药物推荐 或者指南 I 级（强）推荐，得44分；\n" +
                "指南 II 级（中）推荐，或者多中心 RCT 研究提示比现有治疗方案有明显优势，得36分；\n" +
                "指南 III 级（弱）推荐，得30分；\n" +
                "专家共识推荐，得24分；\n" +
                "无以上推荐，得10分.\n" +
                "注意：分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "结论性话术全部以中文结果输出，不用出现小标题，类似XX治疗XX有效性相关结论：等字眼。" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为根据原文内容汇总出成一段总结性的话。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "guide_sdy");
        });
    }

    /***
     * 苏大一的不良反应分析 prompt不一样
     * 安全性--重度和中度不良反应
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject adverseReaction_sdy(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
            query = "请针对我提供的药品说明书中的不良反应资料,分析一下" + drugName + "严重不良反应有哪些，其中严重不良反应的发生率是多少。然后请对分析出来的结果进行打分，打分规则如下：\n" +
                    "16分 说明书及文献中明确描述无严重不良反应\n" +
                    "12分 说明书或文献中描述有严重不良反应，发生率罕见(0.01％~0.1％，含 0.01％)\n" +
                    "8分 说明书或文献中描述有严重不良反应，发生率偶见（0.1％~1％，含 0.1％)\n" +
                    "4分 说明书或文献中描述有严重不良反应，发生率常见（1％-10%，含 1%） 或十分常见\n" +
                    "注意：\n" +
                    "严重药品不良反应参照《药品不良反应报告和监测管理办法》（卫生部令第 81 号）中的定义，" +
                    "是指因使用药品引起以下损害情形之一的反应：（1）导致死亡；（2）危及生命；（3）致癌、致畸、致出生缺陷；（4）导致显著的或者永久的人体伤残或者器官功能的损伤；（5）导致住院或者住院时间延长；（6）导致其他重要医学事件，如不进行治疗可能出现上述所列情况的\n" +
                    "请分别描述十分常见/常见/罕见/偶见的严重不良反应有哪些，发生率如何\n" +
                    "Score：就低原则：符合细则中多项描述时，以最低得分项为准。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段，process为分析过程字段。" +
                    "提供的资料如下：" + drugInfo.getAdverseReaction();
        } else {
            query = "请分析临床指南、文献、临床试验数据库中，" + drugName + "的严重不良反应有哪些，其中严重不良反应的发生率是多少。" +
                    "然后请对分析出来的结果进行打分，打分规则如下：\n" +
                    "16分 说明书及文献中明确描述无严重不良反应\n" +
                    "12分 说明书或文献中描述有严重不良反应，发生率罕见(0.01％~0.1％，含 0.01％)\n" +
                    "8分 说明书或文献中描述有严重不良反应，发生率偶见（0.1％~1％，含 0.1％)\n" +
                    "4分 说明书或文献中描述有严重不良反应，发生率常见（1％-10%，含 1%） 或十分常见\n" +
                    "注意：\n" +
                    "严重药品不良反应参照《药品不良反应报告和监测管理办法》（卫生部令第 81 号）中的定义，" +
                    "是指因使用药品引起以下损害情形之一的反应：（1）导致死亡；（2）危及生命；（3）致癌、致畸、致出生缺陷；（4）导致显著的或者永久的人体伤残或者器官功能的损伤；（5）导致住院或者住院时间延长；（6）导致其他重要医学事件，如不进行治疗可能出现上述所列情况的\n" +
                    "请分别描述十分常见/常见/罕见/偶见的严重不良反应有哪些，发生率如何\n" +
                    "Score：就低原则：符合细则中多项描述时，以最低得分项为准。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段，process为分析过程字段";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "adverseReaction");
        });
    }

    /***
     * 苏大一的同类药物安全优势
     * 安全性--重度和中度不良反应
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject sameMedicineAdvantage_sdy(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请分析临床指南、文献、临床试验数据库，以及知识库中，" +
                "与同类药品相比" + drugName + "在影响临床应用的主要不良反应方面有哪些明显优势。" +
                "然后请对分析出来的结果进行打分，打分规则如下(单选)：\n" +
                "4分 影响临床应用的主要不良反应有明显优势\n" +
                "0分 影响临床应用的主要不良反应无优势\n" +
                "注意：\n" +
                "'当药品无同类药品时，则视同为有优势，给最高分。\n" +
                "'Score' 单选。就低原则：符合细则中多项描述时，以最低得分项为准。\n" +
                "最终给出的'Score'只能是4或者0，不能出现其他分值。" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(query, "adverseReaction");
        });
    }


    /***
     * 苏大一 安全性--特殊人群-婴幼儿
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_childrenMedicine_infant_sdy(String drugName, String disease, DrugInfoNew drugInfo, DrugAddDto drugAdd) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请根据药品说明书、临床指南、文献、临床试验数据库，以及知识库中，" +
                "分析一下" + drugName + "在婴幼儿中的使用情况。然后请对分析出来的结果进行打分，打分规则如下：\n" +
                "2分 婴幼儿一定程度可用" + "'当资料中未明确“禁用”、“忌用”、“不能用”时，则视同为可用，给最高分2分。\n" +
                "0分 婴幼儿不可用\n" +
                "注意：\n" +
                "'当资料中未明确“禁用”、“忌用”、“不能用”时，则视同为可用，给最高分2分。\n" +
                "'Score' 单选。\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";

        if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine()) || StringUtils.isNotEmpty(drugInfo.getChildrenMedicine())) {
            query = query + "相关说明如下：" + (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine()) ? drugAdd.getChildrenMedicine() : drugInfo.getChildrenMedicine());
        }
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_childrenMedicine_infant_sdy");
        });
    }

    /***
     * 苏大一 安全性--特殊人群-儿童
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_childrenMedicine_sdy(String drugName, String disease, DrugInfoNew drugInfo, DrugAddDto drugAdd) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "";
        if (StrUtil.isNotBlank(drugInfo.getChildrenMedicine()) || StrUtil.isNotEmpty(drugAdd.getChildrenMedicine())) {
            query = "请针对我提供的如下资料：\n" +
                    "’’’ " + (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine()) ? drugAdd.getChildrenMedicine() : drugInfo.getChildrenMedicine()) + " ’’’\n" +
                    "请对以上内容进行打分，打分规则如下：\n" +
                    "2分 儿童一定程度可用" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否儿童可用时，均视为可用，给2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均视为可用，给2分。\n" +
                    "0分 儿童不可用\n" +
                    "注意：\n" +
                    "为单选（选取一个最高得分）\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否儿童可用时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示儿童不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“尚无N岁/月以下儿童用药经验”，则表示有些儿童是可用的，给最高分2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        } else {
            query = "请根据药品说明书、临床指南、文献、临床试验数据库，以及知识库中，" +
                    "分析一下" + drugName + "在儿童中的使用情况。" +
                    "然后请对分析出来的结果进行打分，打分规则如下：" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否儿童可用时，均视为可用，给2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均视为可用，给2分。\n" +
                    "2分 儿童一定程度可用\n" +
                    "0分 儿童不可用\n" +
                    "注意：\n" +
                    "为单选（选取一个最高得分）\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否儿童可用时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示儿童不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“尚无N岁/月以下儿童用药经验”，则表示有些儿童是可用的，给最高分2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_childrenMedicine_sdy");
        });
    }

    /***
     * 苏大一 安全性--特殊人群-孕妇可用或哺乳期妇女
     * @param drugName 药品名称
     */
    private JSONObject specialCrowd_pregnantWomen_sdy(String drugName, DrugInfoNew drugInfo, DrugAddDto drugAdd) throws ExecutionException, RetryException {
        String query = "";
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        if (StrUtil.isNotBlank(drugInfo.getPregnantWomen()) || StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
            query = "请针对我提供的如下资料：\n" +
                    "’’’ " + (StringUtils.isNotEmpty(drugAdd.getPregnantWomen()) ? drugAdd.getPregnantWomen() : drugInfo.getPregnantWomen()) + " ’’’\n" +
                    "请对以上内容分别对妊娠期妇女及哺乳期妇女进行打分，打分规则如下：\n" +
                    "2分 孕妇可用或哺乳期妇女一定程度可用" + "孕妇或哺乳期妇女有任何一方可用，均得2分。" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给2分。\n" +
                    "0分 孕妇不可用或哺乳期妇女不可用\n" +
                    "注意：\n" +
                    "Score：单选。孕妇或哺乳期妇女有任何一方可用，均得2分。\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示妊娠期妇女及哺乳期妇女不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“仅在预期获益超过胎儿潜在风险时方可在妊娠期间使用”，则表示可用，给2分。\n" +
                    "如果提供的数据中出现“正在服用本品的女性不应哺乳”，更倾向于表达哺乳期妇女不应使用，给0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给2分。\n" +
                    "原则是，只要没有说不能用，就视为可用，给2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        } else {
            query = "请结合药品说明书、临床指南、文献、药品临床试验及知识库，" +
                    "分析一下" + drugName + "在妊娠期及哺乳期妇女用药方面的相关内容，" +
                    "并根据给出的分析结果内容进行打分，打分规则如下：\n" +
                    "2分 孕妇可用或哺乳期妇女一定程度可用" + "孕妇或哺乳期妇女有任何一方可用，均得2分。" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给2分。\n" +
                    "0分 孕妇不可用或哺乳期妇女不可用\n" +
                    "注意：\n" +
                    "Score：单选。孕妇或哺乳期妇女有任何一方可用，均得2分。\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示妊娠期妇女及哺乳期妇女不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“仅在预期获益超过胎儿潜在风险时方可在妊娠期间使用”，则表示可用，给2分。\n" +
                    "如果提供的数据中出现“正在服用本品的女性不应哺乳”，更倾向于表达哺乳期妇女不应使用，给0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给2分。\n" +
                    "原则是，只要没有说不能用，就视为可用，给2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_pregnantWomen_sdy");
        });
    }

    /***
     * 苏大一 安全性--特殊人群-肝功能异常
     * @param drugName 药品名称
     */
    private JSONObject specialCrowd_liver_sdy(String drugName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        if (StrUtil.isNotBlank(drugInfo.getUsageAndDosage()) || StrUtil.isNotBlank(drugInfo.getNotes())) {
            query = "请结合以下材料中肝功能相关内容，分析" + drugName + "在重度肝功能异常患者中的相关内容，" +
                    "并根据以下规则进行打分，打分规则如下" +
                    "2分 重度肝功能异常一定程度可用\n" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "0分 重度肝功能异常不可用\n" +
                    "注意：\n" +
                    "Score：单选，只显示数值即可，不要出现“分”这个字\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，给最高分2分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为可用，请给最高分2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。" +
                    "请针对我提供的如下资料：" + drugInfo.getUsageAndDosage() + "和" + drugInfo.getNotes();
        } else {
            query = "请结合临床指南、文献、药品说明书、临床试验以及知识库中，" +
                    "分析" + drugName + "在重度肝功能异常患者中的相关内容，" +
                    "并根据给出的分析结果进行打分，打分规则如下：\n" +
                    "2分 重度肝功能异常一定程度可用\n" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "0分 重度肝功能异常不可用\n" +
                    "注意：\n" +
                    "Score：单选，只显示数值即可，不要出现“分”这个字\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，给最高分2分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为可用，请给最高分2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_liver_sdy");
        });
    }

    /***
     * 苏大一 安全性--特殊人群-肾功能异常
     * @param drugName 药品名称
     */
    private JSONObject specialCrowd_kidney_sdy(String drugName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        if (StrUtil.isNotBlank(drugInfo.getUsageAndDosage()) || StrUtil.isNotBlank(drugInfo.getNotes())) {
            query = "请结合以下材料中肝功能相关内容，分析" + drugName + "在重度肝功能异常患者中的相关内容，" +
                    "并根据以下规则进行打分，打分规则如下\n" +
                    "2分 重度肾功能异常一定程度可用" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "0分 重度肾功能异常不可用\n" +
                    "注意：\n" +
                    "Score：单选，只显示数值即可，不要出现“分”这个字\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，给最高分2分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为可用，请给最高分2分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。" +
                    "请针对我提供的如下资料：" + drugInfo.getUsageAndDosage() + "和" + drugInfo.getNotes();
        } else {
            query = "请结合临床指南、文献、药品说明书、临床试验以及知识库中，" +
                    "分析" + drugName + "在重度肾功能异常患者中的相关内容，" +
                    "并根据给出的分析结果进行打分，打分规则如下：\n" +
                    "2分 重度肾功能异常一定程度可用" + "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。" + "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "0分 重度肾功能异常不可用\n" +
                    "注意：\n" +
                    "Score：单选，只显示数值即可，不要出现“分”这个字\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分2分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，给最高分2分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”、“慎用”等表示推荐意见的词语表达时，均表示可用，给最高分2分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为可用，请给最高分2分。" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "specialCrowd_liver_sdy");
        });
    }

    /***
     * 苏大一 安全性--药物警戒
     * @param drugName 药品名称
     */
    private JSONObject pharmacovigilance_sdy(String drugName, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请结合临床指南、文献、药品说明书、临床试验、药监局等官方网站、药品评审中信以及知识库中，" +
                "分析" + drugName + "有无特别用药警示，" +
                "或者说明书黑框警告，或者NMPA、FDA、EMA、WHO 等相关网站通报警戒，" +
                "并根据给出的分析结果进行打分，打分规则如下：\n" +
                "4分 无特别用药警示\n" +
                "0分 有说明书黑框警示或NMPA、FDA、EMA、WHO 等相关网站通报警戒\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "pharmacovigilance_sdy");
        });
    }

    /***
     * 苏大一 安全性--与同类药物的优势
     * @param drugName 药品名称
     */
    private JSONObject advantage_sdy(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugInfo.getDrugName())) {
            queryAdd.append("药品名称：" + drugInfo.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
            queryAdd.append("英文名称：" + drugInfo.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugInfo.getCommunityNameZh() + "/" + drugInfo.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugInfo.getIndication())) {
            queryAdd.append("适应症：" + drugInfo.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugInfo.getManufacturer())) {
            queryAdd.append("厂家：" + drugInfo.getManufacturer() + "\n");
        }
        String query = "请分析临床指南、文献、临床试验数据库，以及知识库中，与同类药品相比，" + drugName + "治疗" + disease + "在临床疗效方面有哪些特别优势。" +
                "然后请对分析出来的结果进行打分，打分规则如下：\n" +
                "4分 与同类药品相比，临床治疗优势明显\n" +
                "0分 与同类药品相比，临床治疗无优势\n" +
                "注意：\n" +
                "当药品无同类药品时，则视同为有优势，给最高分。\n" +
                "若有相关指南及文献证据推荐，请给出相应的指南名称及文献标题。\n" +
                "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数字段（只能是阿拉伯数字组成），process为分析过程字段。";

        Retryer retryer = GuavaRetryer.createRetryer();

        return (JSONObject) retryer.call(() -> {
            return executeGpt(queryAdd + query, "advantage_sdy");
        });
    }



    private String replacePrompt(String prompt, DrugToModel drugToModel){
        final BeanWrapper src = new BeanWrapperImpl(drugToModel);
        Map<String, Object> map = new HashMap<>();

        // 获取所有可读属性的名字
        PropertyDescriptor[] propertyNames = src.getPropertyDescriptors();

        for (PropertyDescriptor propertyName : propertyNames) {

            if (prompt.contains("{"+propertyName.getName()+"}")){

                String propertyValue = src.getPropertyValue(propertyName.getName()).toString();

                if (StringUtils.isNotEmpty(propertyValue)){
                    prompt = prompt.replace("{"+propertyName.getName()+"}",propertyValue);
                }

            }
        }

        return prompt;
    }

    private String getPrompt(PromptEnum promptEnum) {
        JSONObject prompt = mongoTemplate.findOne(new Query(Criteria.where("promptKey").is(promptEnum.getKey())), JSONObject.class);
        if (ObjectUtil.isNotEmpty(prompt)) {
            return prompt.getString("promptContent");
        }
        return "";
    }

    private String getDrugAddPrompt(DrugToModel drugToModel ) {

        StringBuilder queryAdd = new StringBuilder();
        if (StringUtils.isNotEmpty(drugToModel.getDrugName())) {
            queryAdd.append("药品名称：" + drugToModel.getDrugName() + "\n");
        }
        if (StringUtils.isNotEmpty(drugToModel.getDrugEn())) {
            queryAdd.append("英文名称：" + drugToModel.getDrugEn() + "\n");
        }
        queryAdd.append("商品名称：" + drugToModel.getCommunityNameZh() + "/" + drugToModel.getCommunityNameEn() + "\n");
        if (StringUtils.isNotEmpty(drugToModel.getIndication())) {
            queryAdd.append("适应症：" + drugToModel.getIndication() + "\n");
        }
        if (StringUtils.isNotEmpty(drugToModel.getManufacturer())) {
            queryAdd.append("厂家：" + drugToModel.getManufacturer() + "\n");
        }
        return queryAdd.toString();
    }


}
