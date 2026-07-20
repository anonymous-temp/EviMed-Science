package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.DiseaseSplitDisease;
import com.sentum.pojo.vo.DataResult;
import com.sentum.service.LxGptService;
import org.checkerframework.checker.units.qual.A;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Component
public class GptCallUtil {

    @Autowired
    private LxGptService lxGptService;

    @Autowired
    private GptAiUtils gptAiUtils;

    //拆分疾病词语
    public List<String> splitDisease(String disease) {

        String expandedPrompt ="请根据以下疾病定语清洗提炼逻辑，将疾病{"+ disease +"}进行解构，并输出每一步相应的疾病名称\n" +
                "疾病定语清洗提炼逻辑：\n" +
                "1、优先去掉程度描述的词语\n" +
                "去掉描述疾病严重程度的词汇，例如“轻度”“中度”“重度”“极重度”等。这些词通常是对疾病状态的修饰，不属于疾病的核心定义。\n" +
                "2、去掉疾病状态或性质相关的词语\n" +
                "去掉描述疾病状态的词汇，例如“活动性”“急性”“慢性”“复发性”等。这些词是对疾病时间或状态的描述，去掉后仍保留疾病的核心名称。\n" +
                "3、去掉形容疾病特殊性质的词语\n" +
                "去掉描述疾病性质或特定类型的词汇，例如“溃疡性”“过敏性”“感染性”等。这些词是对疾病特征的修饰，去掉后提炼出更基础的疾病名称。\n" +
                "4、保留疾病核心名称\n" +
                "最后保留核心疾病名称，例如“结肠炎”“肺炎”“肝炎”等，提炼出疾病的最简形式。\n" +
                "5、注意疾病名称中的英文简称\n" +
                "对于带有英文缩写的疾病名称，例如“费城染色体阳性的急性淋巴细胞白血病（ph+all）”，需注意：定语去掉后，核心疾病名称不应带上缩写。例如，仅保留“急性淋巴细胞白血病”。\n" +

                "应用逻辑的顺序：\n" +
                "首先去除程度描述词，然后去除状态相关词，再去除特殊性质词，最后保留核心名称。\n" +
                "每一步清理后，检查是否仍保留疾病核心含义，不影响理解。" +
                "在涉及英文缩写的疾病时，务必清晰区分何时应保留核心名称，何时应去掉缩写，确保读者能正确理解疾病名称的缩写与其核心定义之间的关系。" +

                "输出格式要求：\n" +
                "   {\n" +
                "     \"disease\": \"保留原始输入术语\", \n" +
                "     \"deconstruction\": [\"其中一个疾病名称\", \"其中一个疾病名称\", ···]（请不要返回多于的解释）\n" +
                "   }\n" +
                "\n";


        JSONObject response = null;
        try {
            response = gptAiUtils.executeGptPlus(expandedPrompt, "拆分","严格按照json格式返回","","");
        } catch (Exception e) {
            // DashScope chain unavailable; handled by the provider fallback below
        }

//        JSONObject response = lxGptService.executeGptPlus(expandedPrompt, "解构疾病", null, "gpt-4o-2024-11-20", "");

        JSONArray array = response != null ? response.getJSONArray("array") : null;
        if (array == null) {
            // DashScope chain failed or returned non-JSON: fall back to the
            // configured provider chain (DeepSeek via modelStudio).
            try {
                String result = com.sentum.util.utilsy.AIRequestUtils.modelStudio(expandedPrompt, "");
                if (result != null && result.contains("[") && result.contains("]")) {
                    array = com.alibaba.fastjson.JSONArray.parseArray(
                            result.substring(result.indexOf('['), result.lastIndexOf(']') + 1));
                }
            } catch (Exception e) {
                // handled by the final fallback below
            }
        }
        if (array == null) {
            // Last resort: keep the pipeline alive with the original disease term
            List<String> fallback = new ArrayList<>();
            fallback.add(disease);
            return fallback;
        }

        List<String> extendedWords = array.toJavaList(String.class);

        return extendedWords;


    }



    public static double getPatentScoreMax(List<String> status) {
        double maxScore = 0;
        if(CollUtil.isEmpty( status)){
            return 0;
        }
        for (String s : status) {
            double score = getPatentStatusScore(s);
            if (score > maxScore) {
                maxScore = score;
            }
        }
        return maxScore;
    }


    public static double getPatentStatusScore(String status) {

        if (StrUtil.isEmpty(status)){
            return 0;
        }

        switch (status) {
            case "撤回":
            case "未缴年费":
            case "权利终止":
            case "驳回":
            case "放弃":
            case "全部撤销":
            case "专利权转移":
            case "权利质押、保全及解除":
            case "期限届满":
            case "专利申请权转移":
            case "开放许可的声明及撤回":
            case "未知":
                return 0;
            case "公开":
            case "公告送达":
            case "实质审查":
            case "授权":
            case "变更":
            case "避免重复授权":
            case "更正":
            case "保密专利的解密":
            case "权利恢复":
            case "审定":
                return 1;
            default:
                return 0;
        }
    }


}
