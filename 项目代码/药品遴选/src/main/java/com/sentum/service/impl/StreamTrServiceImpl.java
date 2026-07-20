package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.constants.Constants;
import com.sentum.constants.PriorityConstants;
import com.sentum.constants.PromptConstant;
import com.sentum.enums.*;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.FormulaFeign;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.MongoLiterature;
import com.sentum.pojo.Patent;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.GuideSearch;
import com.sentum.service.StreamTrService;
import com.sentum.util.*;
import com.sentum.util.utilsy.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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

import javax.servlet.http.HttpServletResponse;
import java.text.DecimalFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
@Slf4j
public class StreamTrServiceImpl implements StreamTrService {
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
    private EvaluationServiceImpl evaluationService;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private DrugInfoUtil drugInfoUtil;
    @Autowired
    private GuideSearch guideSearch;
    @Autowired
    private GptAiUtils gptAiUtils;
    @Autowired
    private RetryUtils retryUtils;


    @Value("${gpt.isNew}")
    private Boolean isNew;



    public double getPackagingSpecification(String packagQuantity, String singleDose, String medicationFrequency, String pack, String usg) {
        //String prompt = "根据我给出的以下信息，结合计算公式完成计算：\n" +
        //                "计算公式=（包装）/(单次用量*给药频次)\n" +
        //                "***包装：" + packagQuantity + "***单次用量：" + singleDose + "***用药频率：" + medicationFrequency +
        //                "在此过程中或许要参考\n" +
        //                "说明书原文（不一定使用，以上述给出的参数为准,说明书做辅助）：包装：" + pack + "&&&规格:" + usg + "。\n" +
        //                "最后返回一个doble类型的值（保留两位小数），如果信息不全则返回0.0。\n" +
        //                "以下是我提供给你的一个计算示例，请参考：" +
        //                "包装：150丸，单次用量：6丸，用药频次：每日3次，计算过程为：150/(6*3)=8.33。所以最后你返回给我的结果是：8.33\n" +
        //                "注意：只给我返回一个doble类型的小数,无法计算返回0.0，其余计算过程各种东西都不返回";
        
        String prompt = "请严格按照以下规则进行精确计算：\n" +
                "计算公式 = 包装数量 / (单次用量 × 每日给药次数)\n\n" +
                "【参数说明】\n" +
                "1. 必须使用以下核心参数（优先级从高到低）：\n" +
                "   - 包装："+ packagQuantity +"（优先使用纯数字值）\n" +
                "   - 单次用量："+ singleDose +"（必须转换为纯数字）\n" +
                "   - 用药频率："+ medicationFrequency +"（必须提取每日给药次数的数字，如'每日3次'取3）\n\n" +
                "2. 仅当packagQuantity为空/无效时，才参考包装："+ pack +"和规格："+ usg +"中的包装信息\n" +
                "3. 单位处理规则：\n" +
                "   - 如果单次用量与包装数量单位不同，必须确认它们之间是否可换算（如'1片=100mg'）\n" +
                "   - 如果单位无法匹配或换算，视为信息不全，返回0.0\n" +
                "   - 自动忽略单位文字，仅提取数字部分进行计算\n\n" +
                "【关键处理要求】\n" +
                "1. 提取参数时必须：\n" +
                "   - 识别并提取纯数字（如'150丸'→150，'每日3次'→3）\n" +
                "   - 处理小数（如'0.5片'→0.5）\n" +
                "   - 处理中文数字（'三次'→3，'两次'→2）\n" +
                "2. 验证计算前提：\n" +
                "   - 所有参数必须为正数\n" +
                "   - 分母(单次用量×给药频次)不能为0\n" +
                "   - 如果任一参数无效或无法提取，返回0.0\n\n" +
                "【示例参考】\n" +
                "示例1：包装：150丸，单次用量：6丸，用药频次：每日3次 → 150/(6×3)=8.33\n" +
                "示例2：包装：30片，单次用量：0.5片，用药频次：每天2次 → 30/(0.5×2)=30.00\n" +
                "示例3：包装：100ml，单次用量：10ml，用药频次：bid → 100/(10×2)=5.00\n" +
                "示例4：包装：60粒，单次用量：2粒，用药频次：每周3次 → 信息不全（需每日次数），返回0.0\n" +
                "示例5：包装：1瓶(含100片)，单次用量：5片，用药频次：每日4次 → 100/(5×4)=5.00\n\n" +
                "【输出严格要求】\n" +
                "1. 仅返回double类型的计算结果（保留两位小数格式）\n" +
                "2. 任何参数缺失、单位冲突、计算无效时，统一返回'0.00'\n" +
                "3. 绝不返回任何其他文字、说明或计算过程\n" +
                "4. 确保数值计算精确，四舍五入保留两位小数\n\n" +
                "待计算参数：\n" +
                "包装数量：" + packagQuantity + "\n" +
                "单次用量：" + singleDose + "\n" +
                "给药频次：" + medicationFrequency + "\n" +
                "说明书参考：包装：" + pack + "&&&规格:" + usg;


        String aiResult = retryUtils.executeWithRetry(prompt, String.class, "计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
        
        if (StringUtils.isNotEmpty(aiResult)) {
            return extractLastNumber(aiResult);
        }
        return 0.0;
    }

    // 计算最大包装得分
    public double getLargeNumber(String packagQuantity, String singleDose, String usageAndDosage, String pack) {
//
//        String prompt = "根据我给出的以下信息，结合计算公式完成计算：\n" +
//                "计算公式=(包装数量)/(单次用量)\n" +
//                "***包装：" + packagQuantity + "***单次用量：" + singleDose +
//                "在此过程中或许要参考" +
//                "说明书原文（不一定使用，以上述给出的参数为准，说明书做辅助）：【包装】：" + pack + "&&&【用法用量】:" + usageAndDosage + "。最后返回一个doble类型的值（保留两位小数），如果信息不全则返回0.0。\n" +
//                "以下是我提供给你的一个计算示例，请参考：\n" +
//                "包装：50丸 ×3瓶，单次用量：⼀次4-6丸，则计算为 150/6=25（结果保小数点后两位有效数字）（当单次用量为区间数值时，取数值大的那个）。所以最后你返回给我的结果是：25.00\n" +
//                "注意：只给我返回一个doble类型的小数,无法计算返回0.0，其余计算过程各种东西都不返回";

        String prompt = "请根据以下规则完成计算并返回结果：\n" +
                "1. 使用公式：结果 = 包装数量 / 单次用量。\n" +
                "2. 包装数量（packagQuantity）和单次用量（singleDose）以我直接提供的参数为准。\n" +
                "3. 若单次用量为一个范围（如“4-6丸”），请取范围中的最大值作为单次用量。\n" +
                "4. 说明书内容（【包装】：" + pack + "；【用法用量】：" + usageAndDosage + "）仅作辅助参考，不得替代上述参数。\n" +
                "5. 若包装数量或单次用量缺失、无法解析或不合理（如为0），则返回 0.0。\n" +
                "6. 计算结果必须为 double 类型，保留两位小数（如 25.00）。\n" +
                "7. 仅返回最终数值，不要包含任何解释、单位、计算过程或其他文本。\n" +
                "\n" +
                "示例：\n" +
                "包装数量：150（来自“50丸×3瓶”），单次用量：“一次4-6丸” → 取6 → 150 / 6 = 25.00\n" +
                "因此返回：25.00\n" +
                "\n" +
                "现在请根据以下数据计算：\n" +
                "包装数量：" + packagQuantity + "，单次用量：" + singleDose + "\n" +
                "返回结果（仅一个 double 数值，保留两位小数；无法计算则返回 0.0）：";
        
        String aiResult = retryUtils.executeWithRetry(prompt, String.class, "计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

        if (StringUtils.isNotEmpty(aiResult)) {
            return extractLastNumber(aiResult);
        }
        return 0.0;
    }


    // 单次常用量
    public double getSingleDose(String miniQuantity, String singleDose, String usageAndDosage, String specifications) {
//        String prompt = "作为一名临床中药师，你很了解药品的规格与用量。你需要根据我提供给你的数据，提取药品相关规格，以及临床常用单次剂量信息，并根据计算公式给出最终得分：\n" +
//                "计算公式=(单次用量)/(规格)\n" +
//                "’’’\n" +
//                "用户填写的【规格】\n" + miniQuantity + "’’’\n" +
//                "用户填写 【单次用量】\n" + singleDose + "’’’\n" +
//                "系统的【用法用量】\n" + usageAndDosage + "’’’\n" +
//                "系统的【规格】\n" + specifications + "’’’\n" +
//                "提取规则如下：\n" +
//                "首先前提是以用户填写的内容为准（系统内容为辅助），" +
//                "注意：（1）提供的药品规格时，请严格按照我提供给你的数据进行提取，不要自创。如“【规格】每片重0.2g。【用法用量】口服，口服，每次1-2片，一日3次；急性发作时，⼀次6-8片。”，这代表着药品规格是0.2g，1粒=2g。单次用量数据中存在“急性发作时”这种代表非临床常用剂量，属于特殊情况下用药剂量，此种情况下的剂量不能取；同时又存在数值区间范围，如口服，每次1-2片，这时取2片，原则是：当存在多个单次用量时，需要取剂量大值。（2）最后返回一个doble类型的值（保留小数点后两位有效数字），如果信息不全则返回0.0。" +
//                "   示例如下：\n" +
//                "【规格】每丸重60mg(相当于银杏叶提取物16mg)\n" +
//                "【用法用量】口服。一次5丸，一日3次，或遵医嘱。\n" +
//                "提取出来的规格为：60mg，60mg等于1丸；提取出来的单次用量数值为：5丸，则计算为5/1=5";
        
        String prompt = "【任务角色】\n" +
                "您是一名专业临床中药师，请严格按以下规则执行药品规格与剂量评估任务。\n" +
                "\n" +
                "【输入数据】\n" +
                "▌用户填写的【规格】：`{"+ miniQuantity +"}`\n" +
                "▌用户填写的【单次用量】：`{"+ singleDose +"}`\n" +
                "▌系统记录的【用法用量】：`{"+ usageAndDosage +"}`\n" +
                "▌系统记录的【规格】：`{"+ specifications +"}`\n" +
                "\n" +
                "【评估规则】\n" +
                "1. 数据来源优先级：\n" +
                "   • 首要依据：用户填写内容（{规格}和{单次用量}）\n" +
                "   • 辅助参考：系统记录内容（仅用于验证，不替代用户填写）\n" +
                "\n" +
                "2. 规格提取规则：\n" +
                "   • 必须从\"用户填写的【规格】\"中提取\n" +
                "   • 格式要求：识别\"每[单位]含[重量]\"（如\"每片重0.2g\"）\n" +
                "   • 单位识别：自动确定最小单位与对应重量的关系\n" +
                "     - 正确示例：\"每片重0.2g\" → 1片 = 0.2g\n" +
                "     - 正确示例：\"每丸重60mg(相当于提取物16mg)\" → 1丸 = 60mg\n" +
                "   • 禁止自创或修改原始数据\n" +
                "\n" +
                "3. 临床常用单次剂量提取规则：\n" +
                "   • 必须排除特殊情况剂量：\n" +
                "     - 排除含\"急性发作时\"、\"紧急情况\"等描述的剂量\n" +
                "     - 排除\"临床试验\"、\"研究使用\"等非常规剂量\n" +
                "   • 当存在剂量区间时（如\"1-2片\"），**取最大值**（2片）\n" +
                "   • 当存在多条常规剂量说明时，取**数值最大的常规剂量**\n" +
                "   • 优先使用用户填写的【单次用量】，其次参考系统【用法用量】\n" +
                "\n" +
                "4. 无效数据判定：\n" +
                "   • 规格信息缺失或格式错误\n" +
                "   • 无法提取有效临床常用单次剂量\n" +
                "   • 单位不匹配且无法换算\n" +
                "   → 以上情况直接返回0.00\n" +
                "\n" +
                "【计算流程】\n" +
                "1. 确定规格值：1个最小单位 = X重量（如1片 = 0.2g）\n" +
                "2. 确定有效单次剂量：Y个最小单位（排除特殊情况，取最大值）\n" +
                "3. 计算得分：得分 = Y ÷ 1（因为规格定义为1个单位）\n" +
                "4. 保留两位小数，四舍五入\n" +
                "\n" +
                "【输出要求】\n" +
                "• 仅返回计算结果（double类型）\n" +
                "• 严格保留小数点后两位（如5.00、2.50）\n" +
                "• 无效数据返回0.00\n" +
                "• **禁止任何额外文字或解释**\n" +
                "\n" +
                "【示例说明】\n" +
                "\n" +
                "示例1：\n" +
                "▌用户【规格】：每片重0.2g\n" +
                "▌用户【单次用量】：每次1-2片\n" +
                "▌系统【用法用量】：口服，每次1-2片，一日3次；急性发作时，一次6-8片\n" +
                "→ 规格：1片 = 0.2g（取用户填写）\n" +
                "→ 有效剂量：2片（排除\"急性发作时\"，取区间最大值）\n" +
                "→ 计算：2 ÷ 1 = 2.00\n" +
                "\n" +
                "示例2：\n" +
                "▌用户【规格】：每丸重60mg(相当于银杏叶提取物16mg)\n" +
                "▌用户【单次用量】：一次5丸\n" +
                "▌系统【用法用量】：口服。一次5丸，一日3次，或遵医嘱。\n" +
                "→ 规格：1丸 = 60mg（取用户填写，忽略括号内内容）\n" +
                "→ 有效剂量：5丸（常规剂量）\n" +
                "→ 计算：5 ÷ 1 = 5.00\n" +
                "\n" +
                "【执行指令】\n" +
                "请根据输入数据严格按上述规则计算，仅返回结果数字：\n";

        String aiResult = retryUtils.executeWithRetry(prompt, String.class, "计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

        if (StringUtils.isNotEmpty(aiResult)) {
            return extractLastNumber(aiResult);
        }
        return 0.0;
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
        List<String> strings = new ArrayList<>();// 此对象包含的字段
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


//    private void addProcessx(String id, int step, String msg, List<String> stringBuilder) {
//        if (StrUtil.isBlank(msg)) {
//            msg = "";
//        }
//        log.info(msg);
//        stringBuilder.add(msg);
//        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
//    }

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
            if (length > 90) {
                info = info.replaceAll("</br>", "");
                info = calculateScoreAndTruncate(info) + "...";
            }
        }
        return info;
    }

//    private void addProcess(String id, int step, String msg, List<String> stringBuilder) {
//        if (StrUtil.isBlank(msg)) {
//            msg = "";
//        }
//        log.info(msg);
//        msg = formatInfo(msg);
//        stringBuilder.add(msg);
//        redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
//    }


    public int getTrInheritanceEvaluationDto_bak(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrInheritanceEvaluationDto trInheritanceEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("content", "原因");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

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


        JSONObject recipeSourceResult = new JSONObject();
        if(isNew){
            // recipeSourceResult = lxGptService.executeGptPlus(recipeSourcePrompt, "组方来源", responseFormat, "", "10,9,8,7");
            recipeSourceResult = gptAiUtils.executeGptPlus(recipeSourcePrompt, "组方来源", GptDemoEnum.GPT_DEMO_1.getContent(), "", "10,9,8,7");
        }else {
            recipeSourceResult = lxGptService.executeGptPlus(recipeSourcePrompt, "组方来源", responseFormat, "", "10,9,8,7");
        }
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


        write("recipeSourceScore", trInheritanceEvaluationDto.getRecipeSourceScore(), response, cacheDtos, "祖方来源得分");
        write("recipeSourceContent", trInheritanceEvaluationDto.getRecipeSourceContent(), response, cacheDtos, "祖方来源");

        // 理论支持
//        String theorySupportPrompt1 = "你作为一名专业的中药研究研究员，" + (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "请基于药品成份：***" + drugInfoNew.getIngredient() + "***" : "") +
//                " 分析一下" + drugInfoNew.getDrugName() + "研发的理论支撑：\n" +
//                "（1）是否是基于中医药理论指导开发；\n" +
//                "（2）是否遵循中医药的君臣佐使配伍原则；\n" +
//                "（3）君臣药的药性、归经与治疗目标相符；\n" +
//                "（4）君臣药的炮制品选择与治疗目标相符。\n" +
//                "并结合以下评分规则给出最终得分：（多选）\n" +
//                "基于中医药理论指导开发：2分\n" +
//                "遵循中医药的君臣佐使配伍原则：2分\n" +
//                "君臣药的药性、归经与治疗目标相符：1分\n" +
//                "君臣药的炮制品选择与治疗目标相符：1分\n";
//
//        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
//        stringStringHashMap1.put("score", "分数（只能是阿拉伯数字组成）");
//        stringStringHashMap1.put("content", "原因");
//        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
//        JSONObject theorySupportResult1 = lxGptService.executeGptPlus(theorySupportPrompt1, "药理支持", responseFormat1, "");
//        String theorySupportResult1Content = theorySupportResult1.getString("content");
//        String theorySupportResult1Score = theorySupportResult1.getString("score");

        if ("中成药".equals(drugInfoNew.getDrugCategory())) {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(2.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("基于中医药理论指导开发");
        } else {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(0.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("非中医药理论指导开发");
        }

        write("theoryGuidanceScore", trInheritanceEvaluationDto.getTheoryGuidanceScore(), response, cacheDtos, "理论指导得分");
        write("theoryGuidanceContent", trInheritanceEvaluationDto.getTheoryGuidanceContent(), response, cacheDtos, "理论指导");


        int ingredienttype = 3;
        // 君臣佐使配伍
        // 先判断成分性质

        String theorySupportPrompt1 = "你作为一名专业的中药研究员，请根据提供的药品信息进行分析。首先需要判断药品主要成份的数量和类型：\n" +
                "（1）如果药品成份中仅包含单一饮片名称（例如：黄连片的成份只有'黄连'），请返回数字1\n" +
                "（2）如果药品成份中仅包含单一提取物名称（例如：七叶皂苷钠片的主要成份是'七叶皂苷'），请返回数字2\n" +
                "（3）如果药品包含多个成份名称（例如：连花清瘟胶囊的成分有连翘､金银花､炙麻⻩､炒苦杏仁､石膏､板蓝根､绵⻢贯众､⻥腥草､广藿香､大⻩､红景天､薄荷脑､甘草），请返回数字3" +
                "请注意：（1）当药品成份中明确提及“提取物”时，请返回数字2；（2）当药品成份中未明确提到“提取物”三个字，但是其成份名称也是提取物名称时，如三七总皂苷、人参果总皂苷、薯蓣总皂苷等，也请返回数字2；（3）当发现成份中含有提取物名称，且包含了提取物名称的主要成分以及辅料信息时，请直接忽略提取物名称的主要成分以及辅料信息，返回数字2即可。"
                +
                "注意：只返回数字，不返回其他内容\n" +
                "药品信息:" + drugInfoNew.getDrugName() + "" +
                (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "成分为" + drugInfoNew.getIngredient() : "");

            String gpt = lxGptService.getGpt(theorySupportPrompt1, "qwen3-235b-a22b-instruct-2507", "1,2,3");



        try {
            ingredienttype = Integer.parseInt(String.valueOf(extractLastNumber(gpt)));
        } catch (Exception e) {
            // 正则提取其中的数字
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
            String gpt1 = lxGptService.getGpt(theorySupportPrompt2, "", "");

            trInheritanceEvaluationDto.setTheoryCombinationScore(2.0);
            trInheritanceEvaluationDto.setTheoryCombinationContent(gpt1);

        }


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

        write("theoryCombinationScore", trInheritanceEvaluationDto.getTheoryCombinationScore(), response, cacheDtos, "理论支持-君臣佐使配伍得分");
        write("theoryCombinationContent", trInheritanceEvaluationDto.getTheoryCombinationContent(), response, cacheDtos, "理论支持-君臣佐使配伍");
        write("theoryPathogenesisScore", trInheritanceEvaluationDto.getTheoryPathogenesisScore(), response, cacheDtos, "理论支持-药性、归经与治疗目标得分");
        write("theoryPathogenesisContent", trInheritanceEvaluationDto.getTheoryPathogenesisContent(), response, cacheDtos, "理论支持-药性、归经与治疗目标");
        write("theoryPotScore", trInheritanceEvaluationDto.getTheoryPotScore(), response, cacheDtos, "理论支持-炮制品是否与治疗目标相符得分");
        write("theoryPotContent", trInheritanceEvaluationDto.getTheoryPotContent(), response, cacheDtos, "理论支持-炮制品是否与治疗目标相符");


        trInheritanceEvaluationDto.setTheorySupportScore();

        write("theorySupportScore", trInheritanceEvaluationDto.getTheorySupportScore(), response, cacheDtos, "理论支撑得分");


        if (StringUtils.isEmpty(trInheritanceEvaluationDto.getDiseaseCombinationContent1())) {
            // 病证结合
            String diseaseCombinationPrompt = "# 角色\n" +
                    "你是一名专业的中药药师。\n" +
                    "# 任务\n" +
                    "请严格依据以下定义和规则，分析" + drugInfoNew.getDrugName() + "说明书“功能主治”原文中关于**证候、疾病、症状**的描述是否精确，并进行评分。\n" +
                    "# 关键定义（请仔细理解）\n" +
                    "1.  **证候：** 指以气血、阴阳、虚实、寒热等为核心，与脏腑、六淫、六经、卫气营血、三焦、痰、食等概念结合组成的诊断学概念。例如：`肺燥`、`胃寒`、`肝郁`、`肾阴虚`、`湿困脾阳`、`肺蕴痰热`、`心阴亏耗`、`毒热内炽`、`春温入营`。 **⚠\uFE0F 重要提示：药品的“功效”（如“益气养阴”、“滋脾补肾”）不等于“证候”！**\n" +
                    "2.  **疾病：** 指反映人体机能或形质异常变化或病理状态的诊断学概念（通常指西医或中医的明确病名）。\n" +
                    "3.  **症状：** 指疾病引起患者的主观不适、异常感觉、功能变化或明显的病态改变（如：咳嗽、发热、头痛、乏力、食欲不振）。\n" +
                    "# 评分规则（单选，请严格按以下条件判断）\n" +
                    "*   **5分：** 功能主治原文中**同时清晰描述**了 **疾病**、**证候** 和 **症状**。\n" +
                    "*   **3分：** 功能主治原文中**疾病、证候、症状三者中有任何一项缺失或描述不清晰**。\n" +
                    "# 重要注意事项（必须遵守）\n" +
                    "1.  **严格区分功效与证候：** 再次强调，功能主治中表述药品作用的“功效”（如“清热解毒”、“活血化瘀”、“益气养阴”）**不属于**这里定义的“证候”。证候必须是反映患者状态的诊断性描述。\n" +
                    "2.  **严格基于原文，禁止推断：** 评分**必须完全依据**提供的功能主治原文内容。**不得**添加任何原文未明确提及的信息或进行推断。原文写了什么就是什么。\n" +
                    "3.  **精确匹配定义：** 判断“证候”、“疾病”、“症状”时，请严格对照上面给出的定义。\n" +
                    "# 输入：功能主治原文\n" +
                    "以下为药品 `{" + drugInfoNew.getDrugName() + "}}` 说明书中的“功能主治”原文："
                    + drugInfoNew.getIndications() + "\n";

            JSONObject diseaseCombination = new JSONObject();
            if (!isNew) {
                diseaseCombination = lxGptService.executeGptPlus(diseaseCombinationPrompt, "病证结合", responseFormat, "", "5,3,0");
            } else {
                diseaseCombination = gptAiUtils.executeGptPlus(diseaseCombinationPrompt, "病证结合", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,0");
            }

            String diseaseCombinationContent = diseaseCombination.getString("content");
            String diseaseCombinationScore = diseaseCombination.getString("score");
            trInheritanceEvaluationDto.setDiseaseCombinationContent1(diseaseCombinationContent);
            trInheritanceEvaluationDto.setDiseaseCombinationScore1(extractLastNumber(diseaseCombinationScore));
        }
        write("diseaseCombinationScore1", trInheritanceEvaluationDto.getDiseaseCombinationScore1(), response, cacheDtos, "疾病、症侯、疾病描述得分");
        write("diseaseCombinationContent1", trInheritanceEvaluationDto.getDiseaseCombinationContent1(), response, cacheDtos, "疾病、症侯、疾病描述");


        if (StringUtils.isEmpty(trInheritanceEvaluationDto.getDiseaseCombinationContent2())) {
            // 西医描述
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
                    "（4）带有“急性、慢性、特发性、缺血性、感染性、流行性”等现代病理学修饰词时，属于西医病\n" +
                    "（5）带有“器官/组织 +病理词”时，属于西医病：如冠心病、动脉粥样硬化、糖尿病、高血压、痔核、股骨头坏死等。\n" +
                    "（6）如果一个疾病名称既在中医病范畴，又在西医病，请按照西医病算，如：手足藓、体癣、股癣、浸淫疮、内痔、外痔，给1分。\n" +
                    "（7）可以根据以上我提供的相关注意事项（仅供参考，不要局限在以上注意事项中），判断药品的功能主治中是否使用了西医术语描述疾病。只要是有西医描述的疾病名称，就给1分。但是请不要根据你自己的臆想胡乱判断。\n";
            JSONObject westMedicine = new JSONObject();
            if (!isNew){
                westMedicine = lxGptService.executeGptPlus(westMedicinePrompt, "西医描述", responseFormat, "gpt-4o-2024-08-06", "1,0");
            }else {
                westMedicine = gptAiUtils.executeGptPlus(westMedicinePrompt, "西医描述", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
            }

            String westMedicineContent = westMedicine.getString("content");
            String westMedicineScore = westMedicine.getString("score");
            trInheritanceEvaluationDto.setDiseaseCombinationContent2(westMedicineContent);
            trInheritanceEvaluationDto.setDiseaseCombinationScore2(extractLastNumber(westMedicineScore));

        }
        write("diseaseCombinationScore2", trInheritanceEvaluationDto.getDiseaseCombinationScore2(), response, cacheDtos, "西医描述得分");
        write("diseaseCombinationContent2", trInheritanceEvaluationDto.getDiseaseCombinationContent2(), response, cacheDtos, "西医描述");
        trInheritanceEvaluationDto.setDiseaseCombinationScore();


//        addProcessx(id, step++, "<b>1.3 病证结合</b>", stringBuilder);
//        addProcess(id, step++, trInheritanceEvaluationDto.getDiseaseCombinationContent(), stringBuilder);
        write("diseaseCombinationScore", trInheritanceEvaluationDto.getDiseaseCombinationScore(), response, cacheDtos, "病证结合总得分");
        trInheritanceEvaluationDto.setTotalScore();
        write("inheritanceEvaluationTotalScore", trInheritanceEvaluationDto.getTotalScore(), response, cacheDtos, "传承评价综合得分");

        return step;

    }


    public int getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrInheritanceEvaluationDto trInheritanceEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("content", "原因");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

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


        String theorySupportPrompt1 = "你作为一名专业的中药研究员，请根据提供的药品信息进行分析。首先需要判断药品主要成份的数量和类型：\n" +
                "（1）如果药品成份中仅包含单一饮片名称（例如：黄连片的成份只有'黄连'），请返回数字1\n" +
                "（2）如果药品成份中仅包含单一提取物名称（例如：七叶皂苷钠片的主要成份是'七叶皂苷'），请返回数字2\n" +
                "（3）如果药品包含多个成份名称（例如：连花清瘟胶囊的成分有连翘､金银花､炙麻⻩､炒苦杏仁､石膏､板蓝根､绵⻢贯众､⻥腥草､广藿香､大⻩､红景天､薄荷脑､甘草），请返回数字3" +
                "请注意：（1）当药品成份中明确提及“提取物”时，请返回数字2；（2）当药品成份中未明确提到“提取物”三个字，但是其成份名称也是提取物名称时，如三七总皂苷、人参果总皂苷、薯蓣总皂苷等，也请返回数字2；（3）当发现成份中含有提取物名称，且包含了提取物名称的主要成分以及辅料信息时，请直接忽略提取物名称的主要成分以及辅料信息，返回数字2即可。"
                +
                "注意：只返回数字，不返回其他内容\n" +
                "药品信息:" + drugInfoNew.getDrugName() + "" +
                (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "成分为" + drugInfoNew.getIngredient() : "");

        String theorySupportPrompt2 = "你作为一名专业的中药研究研究员，" + (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) ? "请基于药品成份：***" + drugInfoNew.getIngredient() + "***" : "") +
                " 分析一下" + drugInfoNew.getDrugName() + "请分析一下药品成分中的君药、臣药、佐药、使药分别是什么（若是没有，可以不进行叙述，但是不能乱说），发挥的作用是什么？";

        // 创建信号量控制并发数，优先执行前面的任务
        Semaphore semaphore = new Semaphore(5); // 控制并发数为5

        // 并行执行任务，按优先级排序
        CompletableFuture<JSONObject> recipeSourceFuture = CompletableFuture.supplyAsync(() -> {
            try {
                semaphore.acquire();
                if(isNew){
                    return gptAiUtils.executeGptPlus(recipeSourcePrompt, "组方来源", GptDemoEnum.GPT_DEMO_1.getContent(), "", "10,9,8,7");
                }else {
                    return lxGptService.executeGptPlus(recipeSourcePrompt, "组方来源", responseFormat, "", "10,9,8,7");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        CompletableFuture<String> ingredientTypeFuture = CompletableFuture.supplyAsync(() -> {
            try {
                semaphore.acquire();
                return lxGptService.getGpt(theorySupportPrompt1, "qwen3-235b-a22b-instruct-2507", "1,2,3");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "";
            } finally {
                semaphore.release();
            }
        });

        // 等待组方来源和成分类型分析完成，因为后续任务依赖这些结果
        JSONObject recipeSourceResult = new JSONObject();
        String gpt = "";
        try {
            recipeSourceResult = recipeSourceFuture.get();
            gpt = ingredientTypeFuture.get();
        } catch (Exception e) {
            log.error("Error getting parallel results", e);
        }

        // 处理成分类型
        // 替换原来的 ingredienttype 声明与处理逻辑
        final int ingredienttype;
        int ingredienttype1;
        try {
            ingredienttype1 = Integer.parseInt(String.valueOf(extractLastNumber(gpt)));
        } catch (Exception e) {
            // 正则提取其中的数字
            Pattern pattern = Pattern.compile("\\d+");
            Matcher matcher = pattern.matcher(gpt);
            if (matcher.find()) {
                ingredienttype1 = Integer.parseInt(matcher.group());
            } else {
                ingredienttype1 = 3; // 默认值
            }
        }

        // 并行执行其他任务
        ingredienttype = ingredienttype1;
        CompletableFuture<String> theorySupportFuture = CompletableFuture.supplyAsync(() -> {
            if (ingredienttype != 1 && ingredienttype != 2) {
                try {
                    semaphore.acquire();
                    return lxGptService.getGpt(theorySupportPrompt2, "", "");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return "";
                } finally {
                    semaphore.release();
                }
            }
            return "";
        });

        // 病证结合相关任务
        String diseaseCombinationPrompt = "# 角色\n" +
                "你是一名专业的中药药师。\n" +
                "# 任务\n" +
                "请严格依据以下定义和规则，分析" + drugInfoNew.getDrugName() + "说明书“功能主治”原文中关于**证候、疾病、症状**的描述是否精确，并进行评分。\n" +
                "# 关键定义（请仔细理解）\n" +
                "1.  **证候：** 指以气血、阴阳、虚实、寒热等为核心，与脏腑、六淫、六经、卫气营血、三焦、痰、食等概念结合组成的诊断学概念。例如：`肺燥`、`胃寒`、`肝郁`、`肾阴虚`、`湿困脾阳`、`肺蕴痰热`、`心阴亏耗`、`毒热内炽`、`春温入营`。 **⚠\uFE0F 重要提示：药品的“功效”（如“益气养阴”、“滋脾补肾”）不等于“证候”！**\n" +
                "2.  **疾病：** 指反映人体机能或形质异常变化或病理状态的诊断学概念（通常指西医或中医的明确病名）。\n" +
                "3.  **症状：** 指疾病引起患者的主观不适、异常感觉、功能变化或明显的病态改变（如：咳嗽、发热、头痛、乏力、食欲不振）。\n" +
                "# 评分规则（单选，请严格按以下条件判断）\n" +
                "*   **5分：** 功能主治原文中**同时清晰描述**了 **疾病**、**证候** 和 **症状**。\n" +
                "*   **3分：** 功能主治原文中**疾病、证候、症状三者中有任何一项缺失或描述不清晰**。\n" +
                "# 重要注意事项（必须遵守）\n" +
                "1.  **严格区分功效与证候：** 再次强调，功能主治中表述药品作用的“功效”（如“清热解毒”、“活血化瘀”、“益气养阴”）**不属于**这里定义的“证候”。证候必须是反映患者状态的诊断性描述。\n" +
                "2.  **严格基于原文，禁止推断：** 评分**必须完全依据**提供的功能主治原文内容。**不得**添加任何原文未明确提及的信息或进行推断。原文写了什么就是什么。\n" +
                "3.  **精确匹配定义：** 判断“证候”、“疾病”、“症状”时，请严格对照上面给出的定义。\n" +
                "# 输入：功能主治原文\n" +
                "以下为药品 `{" + drugInfoNew.getDrugName() + "}}` 说明书中的“功能主治”原文："
                + drugInfoNew.getIndications() + "\n";

        CompletableFuture<JSONObject> diseaseCombinationFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(trInheritanceEvaluationDto.getDiseaseCombinationContent1())) {
                try {
                    semaphore.acquire();
                    if (!isNew) {
                        return lxGptService.executeGptPlus(diseaseCombinationPrompt, "病证结合", responseFormat, "", "5,3,0");
                    } else {
                        return gptAiUtils.executeGptPlus(diseaseCombinationPrompt, "病证结合", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,0");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new JSONObject();
                } finally {
                    semaphore.release();
                }
            }
            return new JSONObject();
        });

        // 西医描述任务
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
                "（4）带有“急性、慢性、特发性、缺血性、感染性、流行性”等现代病理学修饰词时，属于西医病\n" +
                "（5）带有“器官/组织 +病理词”时，属于西医病：如冠心病、动脉粥样硬化、糖尿病、高血压、痔核、股骨头坏死等。\n" +
                "（6）如果一个疾病名称既在中医病范畴，又在西医病，请按照西医病算，如：手足藓、体癣、股癣、浸淫疮、内痔、外痔，给1分。\n" +
                "（7）可以根据以上我提供的相关注意事项（仅供参考，不要局限在以上注意事项中），判断药品的功能主治中是否使用了西医术语描述疾病。只要是有西医描述的疾病名称，就给1分。但是请不要根据你自己的臆想胡乱判断。\n";

        CompletableFuture<JSONObject> westMedicineFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(trInheritanceEvaluationDto.getDiseaseCombinationContent2())) {
                try {
                    semaphore.acquire();
                    if (!isNew){
                        return lxGptService.executeGptPlus(westMedicinePrompt, "西医描述", responseFormat, "gpt-4o-2024-08-06", "1,0");
                    }else {
                        return gptAiUtils.executeGptPlus(westMedicinePrompt, "西医描述", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new JSONObject();
                } finally {
                    semaphore.release();
                }
            }
            return new JSONObject();
        });

        // 等待所有并行任务完成
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

        write("recipeSourceScore", trInheritanceEvaluationDto.getRecipeSourceScore(), response, cacheDtos, "祖方来源得分");
        write("recipeSourceContent", trInheritanceEvaluationDto.getRecipeSourceContent(), response, cacheDtos, "祖方来源");

        // 理论支持
        if ("中成药".equals(drugInfoNew.getDrugCategory())) {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(2.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("基于中医药理论指导开发");
        } else {
            trInheritanceEvaluationDto.setTheoryGuidanceScore(0.0);
            trInheritanceEvaluationDto.setTheoryGuidanceContent("非中医药理论指导开发");
        }

        write("theoryGuidanceScore", trInheritanceEvaluationDto.getTheoryGuidanceScore(), response, cacheDtos, "理论指导得分");
        write("theoryGuidanceContent", trInheritanceEvaluationDto.getTheoryGuidanceContent(), response, cacheDtos, "理论指导");

        // 君臣佐使配伍
        if (ingredienttype == 1 || ingredienttype == 2) {
            trInheritanceEvaluationDto.setTheoryCombinationScore(0.0);
            trInheritanceEvaluationDto.setTheoryCombinationContent("无法遵循中医药的君臣佐使配伍原则");
        } else {
            try {
                String gpt1 = theorySupportFuture.get();
                trInheritanceEvaluationDto.setTheoryCombinationScore(2.0);
                trInheritanceEvaluationDto.setTheoryCombinationContent(gpt1);
            } catch (Exception e) {
                log.error("Error getting theory support result", e);
                trInheritanceEvaluationDto.setTheoryCombinationScore(2.0);
                trInheritanceEvaluationDto.setTheoryCombinationContent("");
            }
        }

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

        write("theoryCombinationScore", trInheritanceEvaluationDto.getTheoryCombinationScore(), response, cacheDtos, "理论支持-君臣佐使配伍得分");
        write("theoryCombinationContent", trInheritanceEvaluationDto.getTheoryCombinationContent(), response, cacheDtos, "理论支持-君臣佐使配伍");
        write("theoryPathogenesisScore", trInheritanceEvaluationDto.getTheoryPathogenesisScore(), response, cacheDtos, "理论支持-药性、归经与治疗目标得分");
        write("theoryPathogenesisContent", trInheritanceEvaluationDto.getTheoryPathogenesisContent(), response, cacheDtos, "理论支持-药性、归经与治疗目标");
        write("theoryPotScore", trInheritanceEvaluationDto.getTheoryPotScore(), response, cacheDtos, "理论支持-炮制品是否与治疗目标相符得分");
        write("theoryPotContent", trInheritanceEvaluationDto.getTheoryPotContent(), response, cacheDtos, "理论支持-炮制品是否与治疗目标相符");

        trInheritanceEvaluationDto.setTheorySupportScore();
        write("theorySupportScore", trInheritanceEvaluationDto.getTheorySupportScore(), response, cacheDtos, "理论支撑得分");

        // 病证结合
        try {
            JSONObject diseaseCombination = diseaseCombinationFuture.get();
            if (diseaseCombination.containsKey("content") && diseaseCombination.containsKey("score")) {
                String diseaseCombinationContent = diseaseCombination.getString("content");
                String diseaseCombinationScore = diseaseCombination.getString("score");
                trInheritanceEvaluationDto.setDiseaseCombinationContent1(diseaseCombinationContent);
                trInheritanceEvaluationDto.setDiseaseCombinationScore1(extractLastNumber(diseaseCombinationScore));
            }
        } catch (Exception e) {
            log.error("Error getting disease combination result", e);
        }

        write("diseaseCombinationScore1", trInheritanceEvaluationDto.getDiseaseCombinationScore1(), response, cacheDtos, "疾病、症侯、疾病描述得分");
        write("diseaseCombinationContent1", trInheritanceEvaluationDto.getDiseaseCombinationContent1(), response, cacheDtos, "疾病、症侯、疾病描述");

        // 西医描述
        try {
            JSONObject westMedicine = westMedicineFuture.get();
            if (westMedicine.containsKey("content") && westMedicine.containsKey("score")) {
                String westMedicineContent = westMedicine.getString("content");
                String westMedicineScore = westMedicine.getString("score");
                trInheritanceEvaluationDto.setDiseaseCombinationContent2(westMedicineContent);
                trInheritanceEvaluationDto.setDiseaseCombinationScore2(extractLastNumber(westMedicineScore));
            }
        } catch (Exception e) {
            log.error("Error getting west medicine result", e);
        }

        write("diseaseCombinationScore2", trInheritanceEvaluationDto.getDiseaseCombinationScore2(), response, cacheDtos, "西医描述得分");
        write("diseaseCombinationContent2", trInheritanceEvaluationDto.getDiseaseCombinationContent2(), response, cacheDtos, "西医描述");
        trInheritanceEvaluationDto.setDiseaseCombinationScore();

        write("diseaseCombinationScore", trInheritanceEvaluationDto.getDiseaseCombinationScore(), response, cacheDtos, "病证结合总得分");
        trInheritanceEvaluationDto.setTotalScore();
        write("inheritanceEvaluationTotalScore", trInheritanceEvaluationDto.getTotalScore(), response, cacheDtos, "传承评价综合得分");

        return step;
    }



    public int getTrClinicalEvaluationDto_bak(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrClinicalEvaluationDto trClinicalEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {

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

            String gpt;
            if (!isNew){
             gpt = lxGptService.getGpt(prompt, "", "");
            }else {
                 gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "");
            }

            if ("无".equals(gpt)) {
              String  prompt1 ="你作为一名专业的中药药师，" + (StringUtils.isNotEmpty(drugInfoNew.getIndications())?"说明书中的功能主治："+drugInfoNew.getIndications():"") + "请基于药品说明书内容及其给定的指南信息：\n"+
                "分析一下" + drugInfoNew.getDrugName() + "的在临床中定位是怎样的：" +
                        "药品可用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗：\n" +
                        "治疗相关疾病起到主要作用或缓解疾病过程中出现的各种不适症状：\n" +
                        "辅助主要治疗手段，对疾病恢复起到促进作用：\n" +
                        "请注意：" +
                        "（1）结合说明书内容以及相关指南中该药品相关信息，若该药品曾经或者正在用于新发或突发传染病防治（如新冠肺炎），或者能够治疗罕见病或者属于儿童专科疾病的治疗药物，请给出分析原因；" +
                        "（2）若结合说明书内容以及相关指南中该药品相关信息，该药品不能用于（1）时，请分析一下药品在以中医治疗为主的治疗方案中，属于主要治疗药品还是辅助用药？若说明书或指南中明确提及该药品是“辅助用药”；。"+
                      "辅助用药是指在主要治疗（如手术、放疗、化疗、靶向治疗等）基础上，用于增强疗效、减轻副作用、改善患者耐受性或预防并发症的药物。这类药物不直接治疗疾病本身，但对主要治疗起到重要的支持作用（如化疗辅助止吐药）。"+
                      "给定的指南信息如下：\n" + stringBuilder;

              String gpt1;
              if (!isNew){
                  gpt1 = lxGptService.getGpt(prompt1, "", "");
              }else {
                  gpt1 = lxGptService.getGpt(prompt1, "qwen3-235b-a22b-instruct-2507", "");
              }

              trClinicalEvaluationDto.setClinicalPositioningContent(gpt1);
                trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("3"));
            } else {
                trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("5"));
                trClinicalEvaluationDto.setClinicalPositioningContent(gpt);
            }

        } else {


            String clinicalPositioningPrompt = "你是一名专业的中药药师。你的任务是分析药品 **`" + drugInfoNew.getDrugName() + "`** 的临床定位，并根据以下明确的评分规则进行**单选**打分（5分、3分或1分）。\n" +
                    "**药品说明书功能主治信息：**\n" +
                    (StringUtils.isNotEmpty(drugInfoNew.getIndications()) ? drugInfoNew.getIndications() : "（未提供功能主治信息）") +
                    "**评分规则（单选）：**\n" +
                    "1.  **5分标准：** 该药品可用于新发突发传染病防治（如新冠肺炎）、重大难治罕见病或儿童专科疾病的治疗。\n" +
                    "    *   **关键判定点：** 如果该药品曾经或正在用于新发突发传染病防治，或者能够治疗重大难治罕见病，或者属于儿童专科疾病的治疗药物，则必须选择此项并给5分。请说明符合哪一项及原因。\n" +
                    "2.  **3分标准：** 该药品在治疗相关疾病中起到主要作用，或能缓解疾病过程中出现的各种不适症状。\n" +
                    "    *   **关键判定点：** 如果药品不符合5分标准，且说明书或相关指南中**未**明确将其定义为“辅助用药”，则认为它在治疗方案中起到主要作用或缓解核心症状，应给3分。\n" +
                    "3.  **1分标准：** 该药品属于辅助用药，用于辅助主要治疗手段（如手术、放疗、化疗、靶向治疗等），对疾病恢复起到促进作用（如增强疗效、减轻副作用、改善耐受性、预防并发症），但不直接治疗疾病本身（例如：化疗辅助止吐药）。\n" +
                    "    *   **关键判定点：** 如果药品不符合5分标准，且说明书或相关指南中**明确**提及该药品是“辅助用药”，则给1分。\n" +
                    "**执行步骤与要求：**\n" +
                    "1.  **首要判断（5分）：** 仔细分析药品说明书（功能主治）和你的专业知识：\n" +
                    "    *   该药是否用于/曾用于 **新发突发传染病防治** (如新冠肺炎等)？\n" +
                    "    *   该药是否用于治疗 **重大难治罕见病**？\n" +
                    "    *   该药是否属于 **儿童专科疾病治疗药物**？\n" +
                    "    *   **如果以上任一答案为“是”**，则**必须选择5分**。清晰说明符合哪一项及具体原因（基于说明书或已知信息）。\n" +
                    "    *   **如果以上答案均为“否”**，则进入下一步判断。\n" +
                    "2.  **次要判断（1分 vs 3分）：**\n" +
                    "    *   查阅说明书和相关指南，**明确寻找**关于该药品是否为“辅助用药”的描述。\n" +
                    "    *   **如果找到明确描述**（如明确指出是“辅助治疗”、“辅助用药”、“配合XX使用”等），则选择 **1分**。引用依据并说明它辅助的主要治疗手段是什么（如果信息中有）。\n" +
                    "    *   **如果未找到明确描述其为“辅助用药”**，则认为该药品在中医治疗为主的方案中通常起到**主要治疗作用或缓解核心症状的作用**，选择 **3分**。\n" +
                    "**最终输出要求：**\n" +
                    "*   清晰说明你选择的分数（5分、3分或1分）。\n" +
                    "*   详细阐述你的分析过程和判断依据，特别是：\n" +
                    "    *   是否符合5分标准中的哪一项（如果选5分）。\n" +
                    "    *   是否找到明确将其定义为“辅助用药”的证据（如果选1分）。\n" +
                    "    *   为什么认为它是主要治疗或缓解核心症状（如果选3分）。\n" +
                    "*   分析必须严格基于提供的药品说明书功能主治信息（`" + drugInfoNew.getIndications() + "`）以及中药药理和临床实践知识，必要时提及参考了相关指南原则（即使指南名未具体给出）。\n" +
                    "*   回答需专业、严谨、逻辑清晰。";

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
            stringStringHashMap.put("content", "分析过程");
            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject clinicalPositioning = null;
            if (!isNew) {
                clinicalPositioning = lxGptService.executeGptPlus(clinicalPositioningPrompt, "临床定位", responseFormat, "gpt-5-mini", "5,3,1");
            } else {
               clinicalPositioning = gptAiUtils.executeGptPlus(clinicalPositioningPrompt, "临床定位", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,1");
            }

            String clinicalPositioningContent = clinicalPositioning.getString("content");
            String clinicalPositioningScore = clinicalPositioning.getString("score");

            trClinicalEvaluationDto.setClinicalPositioningContent(clinicalPositioningContent);
            trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber(clinicalPositioningScore));
        }

//        addProcessx(id, step++, "<b>2、临床评价</b>", stringBuilderx);
//        addProcessx(id, step++, "<b>2.1 临床定位</b>", stringBuilderx);
//        addProcess(id, step++, trClinicalEvaluationDto.getClinicalPositioningContent(), stringBuilderx);
        write("clinicalPositioningScore", trClinicalEvaluationDto.getClinicalPositioningScore(), response, cacheDtos, "临床定位得分");
        write("clinicalPositioningContent", trClinicalEvaluationDto.getClinicalPositioningContent(), response, cacheDtos, "临床定位");


        // 临床研究


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


        ArrayList<JSONObject> evidenceItemes = new ArrayList<>();
        if (literatureSearchHits.getTotalHits() > 0) {
            String string = "";
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                String title = literatureSearchHit.getContent().getTitle();
                String summary = literatureSearchHit.getContent().getSummary();
                string += "(" + count + ")" + title + "\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                JSONObject evidenceItem = new JSONObject();
                evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                evidenceItem.put("content", summary);
                evidenceItemes.add(evidenceItem);
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
                string += "(" + count + ")" + title + "\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                JSONObject evidenceItem = new JSONObject();
                evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                evidenceItem.put("content", summary);
                evidenceItemes.add(evidenceItem);
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
                string += "(" + count + ")" + title + "\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                JSONObject evidenceItem = new JSONObject();
                evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                evidenceItem.put("content", summary);
                evidenceItemes.add(evidenceItem);
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
                string += "(" + count + ")" + title + "\n";
                string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                JSONObject evidenceItem = new JSONObject();
                evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                evidenceItem.put("content", summary);
                evidenceItemes.add(evidenceItem);
                count++;
            }
            trClinicalEvaluationDto.setClinicalResearchContent(string);
            trClinicalEvaluationDto.setClinicalResearchScore(1.0);
        } else {
            trClinicalEvaluationDto.setClinicalResearchContent("未找到相关文献");
            trClinicalEvaluationDto.setClinicalResearchScore(0.0);

        }
//        addProcessx(id, step++, "<b>2.2 临床研究</b>", stringBuilderx);
//        addProcess(id, step++, trClinicalEvaluationDto.getClinicalResearchContent(), stringBuilderx);

        write("clinicalResearchScore", trClinicalEvaluationDto.getClinicalResearchScore(), response, cacheDtos, "临床研究得分");
        write("clinicalResearchContent", evidenceItemes, response, cacheDtos, "临床研究");


        // 证据推荐
        TrGuideVo TrguideVO = guideSearch.getGuideWithCache(drugZhs, drugInfoNew.getDrugZh());
        List<GuideVO> guideVOS = TrguideVO.getGuideVOList();
        if (guideVOS.size() > 0) {

            for (GuideVO guideVO : guideVOS) {
                TrClinicalEvaluationDto.EvidenceItem evidenceItem = new TrClinicalEvaluationDto.EvidenceItem("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate(), guideVO.getPdf_txt());
                trClinicalEvaluationDto.getEvidenceItems().add(evidenceItem);
            }
            trClinicalEvaluationDto.setEvidenceRecommendationScore(TrguideVO.getScore());
        }

        write("evidenceRecommendationScore", trClinicalEvaluationDto.getEvidenceRecommendationScore(), response, cacheDtos, "证据推荐得分");
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
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        for (TrClinicalEvaluationDto.EvidenceItem evidenceItem : evidenceItems) {
            JSONObject jsonObjectt = new JSONObject();
            jsonObjectt.put("title", evidenceItem.getTitle());
            jsonObjectt.put("content", evidenceItem.getContent());
            jsonObjects.add(jsonObjectt);
        }

        write("evidenceRecommendationContent", jsonObjects, response, cacheDtos, "证据推荐");

//        //临床需求
//        trClinicalEvaluationDto.setClinicalDemandOption("填补本院用药目录空白");
        trClinicalEvaluationDto.setClinicalDemandScore(0.0);


        write("clinicalDemandScore", trClinicalEvaluationDto.getClinicalDemandScore(), response, cacheDtos, "临床需求得分");
        write("clinicalDemandOption", "", response, cacheDtos, "临床需求");
        write("clinicalDemandContent", "", response, cacheDtos, "临床需求描述");

        trClinicalEvaluationDto.setTotalScore();

        write("trClinicalEvaluationTotalScore", trClinicalEvaluationDto.getTotalScore(), response, cacheDtos, "临床评价总得分");

//        addProcessx(id, step++, "<b>2.4 临床需求</b>", stringBuilderx);
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

//        addProcess(id, step++, trClinicalEvaluationDto.getClinicalDemandOption(), stringBuilderx);

        return step;


    }


    public int getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrClinicalEvaluationDto trClinicalEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {
        // 初始化信号量控制并发
        Semaphore semaphore = new Semaphore(5);

        // 第一部分：指南查询和临床定位分析
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

        // 并行处理临床定位任务
        CompletableFuture<JSONObject> clinicalPositioningFuture = CompletableFuture.supplyAsync(() -> {
            if (literatureSearchHits5.getTotalHits() <= 0) {
                String clinicalPositioningPrompt = "你是一名专业的中药药师。你的任务是分析药品 **`" + drugInfoNew.getDrugName() + "`** 的临床定位，并根据以下明确的评分规则进行**单选**打分（5分、3分或1分）。\n" +
                        "**药品说明书功能主治信息：**\n" +
                        (StringUtils.isNotEmpty(drugInfoNew.getIndications()) ? drugInfoNew.getIndications() : "（未提供功能主治信息）") +
                        "**评分规则（单选）：**\n" +
                        "1.  **5分标准：** 该药品可用于新发突发传染病防治（如新冠肺炎）、重大难治罕见病或儿童专科疾病的治疗。\n" +
                        "    *   **关键判定点：** 如果该药品曾经或正在用于新发突发传染病防治，或者能够治疗重大难治罕见病，或者属于儿童专科疾病的治疗药物，则必须选择此项并给5分。请说明符合哪一项及原因。\n" +
                        "2.  **3分标准：** 该药品在治疗相关疾病中起到主要作用，或能缓解疾病过程中出现的各种不适症状。\n" +
                        "    *   **关键判定点：** 如果药品不符合5分标准，且说明书或相关指南中**未**明确将其定义为“辅助用药”，则认为它在治疗方案中起到主要作用或缓解核心症状，应给3分。\n" +
                        "3.  **1分标准：** 该药品属于辅助用药，用于辅助主要治疗手段（如手术、放疗、化疗、靶向治疗等），对疾病恢复起到促进作用（如增强疗效、减轻副作用、改善耐受性、预防并发症），但不直接治疗疾病本身（例如：化疗辅助止吐药）。\n" +
                        "    *   **关键判定点：** 如果药品不符合5分标准，且说明书或相关指南中**明确**提及该药品是“辅助用药”，则给1分。\n" +
                        "**执行步骤与要求：**\n" +
                        "1.  **首要判断（5分）：** 仔细分析药品说明书（功能主治）和你的专业知识：\n" +
                        "    *   该药是否用于/曾用于 **新发突发传染病防治** (如新冠肺炎等)？\n" +
                        "    *   该药是否用于治疗 **重大难治罕见病**？\n" +
                        "    *   该药是否属于 **儿童专科疾病治疗药物**？\n" +
                        "    *   **如果以上任一答案为“是”**，则**必须选择5分**。清晰说明符合哪一项及具体原因（基于说明书或已知信息）。\n" +
                        "    *   **如果以上答案均为“否”**，则进入下一步判断。\n" +
                        "2.  **次要判断（1分 vs 3分）：**\n" +
                        "    *   查阅说明书和相关指南，**明确寻找**关于该药品是否为“辅助用药”的描述。\n" +
                        "    *   **如果找到明确描述**（如明确指出是“辅助治疗”、“辅助用药”、“配合XX使用”等），则选择 **1分**。引用依据并说明它辅助的主要治疗手段是什么（如果信息中有）。\n" +
                        "    *   **如果未找到明确描述其为“辅助用药”**，则认为该药品在中医治疗为主的方案中通常起到**主要治疗作用或缓解核心症状的作用**，选择 **3分**。\n" +
                        "**最终输出要求：**\n" +
                        "*   清晰说明你选择的分数（5分、3分或1分）。\n" +
                        "*   详细阐述你的分析过程和判断依据，特别是：\n" +
                        "    *   是否符合5分标准中的哪一项（如果选5分）。\n" +
                        "    *   是否找到明确将其定义为“辅助用药”的证据（如果选1分）。\n" +
                        "    *   为什么认为它是主要治疗或缓解核心症状（如果选3分）。\n" +
                        "*   分析必须严格基于提供的药品说明书功能主治信息（`" + drugInfoNew.getIndications() + "`）以及中药药理和临床实践知识，必要时提及参考了相关指南原则（即使指南名未具体给出）。\n" +
                        "*   回答需专业、严谨、逻辑清晰。";

                HashMap<String, String> stringStringHashMap = new HashMap<>();
                stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
                stringStringHashMap.put("content", "分析过程");
                JSONObject responseFormat = getResponseFormat(stringStringHashMap);

                try {
                    semaphore.acquire();
                    if (!isNew) {
                        return lxGptService.executeGptPlus(clinicalPositioningPrompt, "临床定位", responseFormat, "gpt-5-mini", "5,3,1");
                    } else {
                        return gptAiUtils.executeGptPlus(clinicalPositioningPrompt, "临床定位", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,1");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new JSONObject();
                } finally {
                    semaphore.release();
                }
            }
            return new JSONObject();
        });

        // 并行处理指南相关分析
        CompletableFuture<String> guideAnalysisFuture = CompletableFuture.supplyAsync(() -> {
            if (literatureSearchHits5.getTotalHits() > 0) {
                StringBuilder stringBuilder = new StringBuilder();
                ArrayList<GuideVO> guideVOS = new ArrayList<>();
                for (SearchHit<GuideVO> searchHit : literatureSearchHits5.getSearchHits()) {
                    GuideVO content = searchHit.getContent();
                    List<String> blocks = content.getBlocks();
                    String blockx = "";
                    for (String block : blocks) {
                        if (containsName(block, drugs)) {
                            blockx += block;
                        }
                    }
                    if (blockx.length() > 0) {
                        content.setBlock(blockx);
                        guideVOS.add(content);
                    }
                    stringBuilder.append("标题：" + content.getTitle()).append("\n");
                    stringBuilder.append(blockx);
                    if (guideVOS.size() > 5) {
                        break;
                    }
                }
                String prompt = "请根据我给出的指南标题判断" + drugInfoNew.getDrugName() + "是否是有治疗重大突发疾病，如新冠肺炎，若有返回相关信息，若无则返回'无'，返回'无'时请不要返回其他内容" +
                        "" + "，指南如下:\n" +
                        stringBuilder.toString();

                try {
                    semaphore.acquire();
                    if (!isNew) {
                        return lxGptService.getGpt(prompt, "", "");
                    } else {
                        return lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return "无";
                } finally {
                    semaphore.release();
                }
            }
            return "无";
        });

        // 第二部分：临床研究查询
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

        // 并行执行临床研究查询
        CompletableFuture<SearchHits<Literature>> literatureSearchHitsFuture = CompletableFuture.supplyAsync(() ->
                this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class));
        CompletableFuture<SearchHits<Literature>> literatureSearchHits2Future = CompletableFuture.supplyAsync(() ->
                this.elasticsearchRestTemplate.search(nativeSearchQuery2, Literature.class));
        CompletableFuture<SearchHits<Literature>> literatureSearchHits3Future = CompletableFuture.supplyAsync(() ->
                this.elasticsearchRestTemplate.search(nativeSearchQuery3, Literature.class));
        CompletableFuture<SearchHits<Literature>> literatureSearchHits4Future = CompletableFuture.supplyAsync(() ->
                this.elasticsearchRestTemplate.search(nativeSearchQuery4, Literature.class));

        // 第三部分：证据推荐查询
        CompletableFuture<TrGuideVo> guideWithCacheFuture = CompletableFuture.supplyAsync(() ->
                guideSearch.getGuideWithCache(drugZhs, drugInfoNew.getDrugZh()));

        // 等待所有并行任务完成并处理结果
        try {
            // 处理临床定位结果
            JSONObject clinicalPositioning = clinicalPositioningFuture.get();
            String gpt = guideAnalysisFuture.get();

            if (literatureSearchHits5.getTotalHits() > 0) {
                if ("无".equals(gpt)) {
                    String prompt1 = "你作为一名专业的中药药师，" + (StringUtils.isNotEmpty(drugInfoNew.getIndications()) ? "说明书中的功能主治：" + drugInfoNew.getIndications() : "") + "请基于药品说明书内容及其给定的指南信息：\n" +
                            "分析一下" + drugInfoNew.getDrugName() + "的在临床中定位是怎样的：" +
                            "药品可用于新发突发传染病防治、重大难治罕见病或儿童专科疾病的治疗：\n" +
                            "治疗相关疾病起到主要作用或缓解疾病过程中出现的各种不适症状：\n" +
                            "辅助主要治疗手段，对疾病恢复起到促进作用：\n" +
                            "请注意：" +
                            "（1）结合说明书内容以及相关指南中该药品相关信息，若该药品曾经或者正在用于新发或突发传染病防治（如新冠肺炎），或者能够治疗罕见病或者属于儿童专科疾病的治疗药物，请给出分析原因；" +
                            "（2）若结合说明书内容以及相关指南中该药品相关信息，该药品不能用于（1）时，请分析一下药品在以中医治疗为主的治疗方案中，属于主要治疗药品还是辅助用药？若说明书或指南中明确提及该药品是'辅助用药'；。" +
                            "辅助用药是指在主要治疗（如手术、放疗、化疗、靶向治疗等）基础上，用于增强疗效、减轻副作用、改善患者耐受性或预防并发症的药物。这类药物不直接治疗疾病本身，但对主要治疗起到重要的支持作用（如化疗辅助止吐药）。" +
                            "给定的指南信息如下：\n" + stringBuilder;

                    String gpt1;
                    try {
                        semaphore.acquire();
                        if (!isNew) {
                            gpt1 = lxGptService.getGpt(prompt1, "", "");
                        } else {
                            gpt1 = lxGptService.getGpt(prompt1, "qwen3-235b-a22b-instruct-2507", "");
                        }
                    } finally {
                        semaphore.release();
                    }

                    trClinicalEvaluationDto.setClinicalPositioningContent(gpt1);
                    trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("3"));
                } else {
                    trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("5"));
                    trClinicalEvaluationDto.setClinicalPositioningContent(gpt);
                }
            } else {
                if (clinicalPositioning.containsKey("content") && clinicalPositioning.containsKey("score")) {
                    String clinicalPositioningContent = clinicalPositioning.getString("content");
                    String clinicalPositioningScore = clinicalPositioning.getString("score");
                    trClinicalEvaluationDto.setClinicalPositioningContent(clinicalPositioningContent);
                    trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber(clinicalPositioningScore));
                }
            }

            write("clinicalPositioningScore", trClinicalEvaluationDto.getClinicalPositioningScore(), response, cacheDtos, "临床定位得分");
            write("clinicalPositioningContent", trClinicalEvaluationDto.getClinicalPositioningContent(), response, cacheDtos, "临床定位");

            // 处理临床研究结果
            SearchHits<Literature> literatureSearchHits = literatureSearchHitsFuture.get();
            SearchHits<Literature> literatureSearchHits2 = literatureSearchHits2Future.get();
            SearchHits<Literature> literatureSearchHits3 = literatureSearchHits3Future.get();
            SearchHits<Literature> literatureSearchHits4 = literatureSearchHits4Future.get();

            ArrayList<JSONObject> evidenceItemes = new ArrayList<>();
            if (literatureSearchHits.getTotalHits() > 0) {
                String string = "";
                int count = 1;
                for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                    String title = literatureSearchHit.getContent().getTitle();
                    String summary = literatureSearchHit.getContent().getSummary();
                    string += "(" + count + ")" + title + "\n";
                    string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                    JSONObject evidenceItem = new JSONObject();
                    evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                    evidenceItem.put("content", summary);
                    evidenceItemes.add(evidenceItem);
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
                    string += "(" + count + ")" + title + "\n";
                    string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                    JSONObject evidenceItem = new JSONObject();
                    evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                    evidenceItem.put("content", summary);
                    evidenceItemes.add(evidenceItem);
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
                    string += "(" + count + ")" + title + "\n";
                    string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                    JSONObject evidenceItem = new JSONObject();
                    evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                    evidenceItem.put("content", summary);
                    evidenceItemes.add(evidenceItem);
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
                    string += "(" + count + ")" + title + "\n";
                    string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";
                    JSONObject evidenceItem = new JSONObject();
                    evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
                    evidenceItem.put("content", summary);
                    evidenceItemes.add(evidenceItem);
                    count++;
                }
                trClinicalEvaluationDto.setClinicalResearchContent(string);
                trClinicalEvaluationDto.setClinicalResearchScore(1.0);
            } else {
                trClinicalEvaluationDto.setClinicalResearchContent("未找到相关文献");
                trClinicalEvaluationDto.setClinicalResearchScore(0.0);
            }

            write("clinicalResearchScore", trClinicalEvaluationDto.getClinicalResearchScore(), response, cacheDtos, "临床研究得分");
            write("clinicalResearchContent", evidenceItemes, response, cacheDtos, "临床研究");

            // 处理证据推荐结果
            TrGuideVo TrguideVO = guideWithCacheFuture.get();
            List<GuideVO> guideVOS = TrguideVO.getGuideVOList();
            if (guideVOS.size() > 0) {
                for (GuideVO guideVO : guideVOS) {
                    TrClinicalEvaluationDto.EvidenceItem evidenceItem = new TrClinicalEvaluationDto.EvidenceItem("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate(), guideVO.getPdf_txt());
                    trClinicalEvaluationDto.getEvidenceItems().add(evidenceItem);
                }
                trClinicalEvaluationDto.setEvidenceRecommendationScore(TrguideVO.getScore());
            }

            write("evidenceRecommendationScore", trClinicalEvaluationDto.getEvidenceRecommendationScore(), response, cacheDtos, "证据推荐得分");

            List<TrClinicalEvaluationDto.EvidenceItem> evidenceItems = trClinicalEvaluationDto.getEvidenceItems();
            ArrayList<JSONObject> jsonObjects = new ArrayList<>();
            for (TrClinicalEvaluationDto.EvidenceItem evidenceItem : evidenceItems) {
                JSONObject jsonObjectt = new JSONObject();
                jsonObjectt.put("title", evidenceItem.getTitle());
                jsonObjectt.put("content", evidenceItem.getContent());
                jsonObjects.add(jsonObjectt);
            }

            write("evidenceRecommendationContent", jsonObjects, response, cacheDtos, "证据推荐");

            // 临床需求
            trClinicalEvaluationDto.setClinicalDemandScore(0.0);
            write("clinicalDemandScore", trClinicalEvaluationDto.getClinicalDemandScore(), response, cacheDtos, "临床需求得分");
            write("clinicalDemandOption", "", response, cacheDtos, "临床需求");
            write("clinicalDemandContent", "", response, cacheDtos, "临床需求描述");

            trClinicalEvaluationDto.setTotalScore();
            write("trClinicalEvaluationTotalScore", trClinicalEvaluationDto.getTotalScore(), response, cacheDtos, "临床评价总得分");

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
        } catch (Exception e) {
            log.error("Error processing clinical evaluation", e);
        }

        return step;
    }




    // public TrGuideVo getGuideWithCache(List<String> drugZhs, String drugZh) {
    //
    //     TrGuideVo trGuideVo = new TrGuideVo();
    //     ArrayList<GuideVO> guideVOS1 = new ArrayList<>();
    //     trGuideVo.setGuideVOList(guideVOS1);
    //
    //     // 缓存中不存在数据，执行查询
    //     List<GuideVO> guideVOS = lxGptService.queryGuideByDrugAndDiseaseTr(drugZhs, drugZh, null, "");
    //
    //     if (guideVOS != null) {
    //         String guideTitle = "";
    //         for (GuideVO guideVO : guideVOS) {
    //             guideTitle = guideTitle + "**********指南id:" + guideVO.getId() +
    //                     "指南标题:" + guideVO.getTitle() +
    //                     "指南"
    //                     + "**********";
    //         }
    //
    //
    //         String prompt = "请根据我提供的指南信息，找出与“drugname”相关并符合以下评分规则中等级最高的相关指南。请注意：我需要的“drugname”单独使用的相关指南，若指南中描述的是其他药品与“drugname”联合使用的情况，请过滤这些指南（即：联合用药相关指南直接舍弃），过滤之后具体规则如下:" +
    //                 "以下评分规则，由上至下等级逐渐变低：\n" +
    //                 "诊疗规范（关键词：诊疗规范、指导原则）：10分\n" +
    //                 "中成药治疗优势病种临床应用指南（关键词：指南标题中带有“中成药治疗”及“临床应用指南”字样）：10分（示例：中成药治疗痛经临床应用指南（2021年））\n" +
    //                 "由国家级学会（如：中华医学会、中国药学会、中华中医药学会、欧洲心脏病学会等，具体可参见《中华人民共和国国家一级学会目录》）组织发布的指南：9分\n" +
    //                 "除了国家级学会的其他级别学会（如：省级学会/协会、市级学会/协会、区县级学会/协会、高校或医院内部学会、行业或跨区域联合学会、国际学会的中国分支机构等）组织发布的指南：8分\n" +
    //                 "由国家级学会组织（如：中华医学会、中国药学会、中华中医药学会、欧洲心脏病学会等，可参见《中华人民共和国国家一级学会目录》）发布的专家共识推荐：7分\n" +
    //                 "除了国家级学会的其他级别学会（如：省级学会/协会、市级学会/协会、区县级学会/协会、高校或医院内部学会、行业或跨区域联合学会、国际学会的中国分支机构等）组织发布的专家共识：6分\n" +
    //                 "\n给出的指南如下：" + guideTitle + "" +
    //                 "$$$$$$$$$$$返回规则：返回两个字段：1.一个数字：最高的得分 2.String类型：符合最高得分等级的指南（取6篇，如果有多的按相关度取相关度最高的六篇关键词为:" + drugZh + "）," +
    //                 "返回它们的id,id拼接为一个字符串，id中间用英文','隔开";
    //         HashMap<String, String> stringStringHashMap = new HashMap<>();
    //         stringStringHashMap.put("score", "一个数字：最高的得分");
    //         stringStringHashMap.put("ids", "String类型：符合最高得分等级的指南（取6篇，如果有多的按相关度取相关度最高的六篇关键词为:" + drugZh + "）,返回它们的id,id拼接为一个字符串，id中间用英文','隔开");
    //         JSONObject responseFormat = getResponseFormat(stringStringHashMap);
    //         JSONObject jsonObject = lxGptService.executeGptPlus(prompt, "指南", responseFormat, "","10,9,8,7,6");
    //         String ids = jsonObject.getString("ids");
    //         String[] id = ids.split(",");
    //
    //         String score = jsonObject.getString("score");
    //         trGuideVo.setScore(Double.parseDouble(formatScore(score)));
    //
    //         //转为list
    //         List<String> idList = Arrays.asList(id);
    //
    //         String guides = "";
    //
    //         HashMap<String, String> stringStringHashMap2 = new HashMap<>();
    //         for (GuideVO guideVO : guideVOS) {
    //             if (idList.contains(guideVO.getId())) {
    //                 guides = guides + "************指南id:" + guideVO.getId() + "指南标题:" + guideVO.getTitle() + "指南节选:" + guideVO.getPdf_txt() + "**********";
    //                 stringStringHashMap2.put(guideVO.getId(), "指南id为" + guideVO.getId() + "的指南总结的内容（原文什么语言则返回什么语言）");
    //             }
    //         }
    //
    //         String prompt2 = " 我现在正在研究" + drugZh + "的指南，请把下列指南每篇给我总结一段话，关于" + drugZh + "指南如下:"
    //                 + guides + "json返回,返回的字段名就是对应id，值为总结(返回的内容务必提及"+drugZh+")";
    //         JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
    //         JSONObject jsonObject2 = lxGptService.executeGptPlus(prompt2, "指南总结", responseFormat2, "","");
    //
    //         for (GuideVO guideVO : guideVOS) {
    //             if (idList.contains(guideVO.getId())) {
    //                 if (jsonObject2.containsKey(guideVO.getId())) {
    //                     guideVO.setPdf_txt(jsonObject2.getString(guideVO.getId()));
    //                     guideVOS1.add(guideVO);
    //                 }
    //             }
    //         }
    //
    //
    //     }
    //
    //     return trGuideVo;
    // }


    private boolean containsName(String block, List<String> drugNames) {
        for (String drugName : drugNames) {
            if (block.contains(drugName)) {
                return true;
            }
        }
        return false;
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


    // 安全性内容
    public int getTrSafetyEvaluationDto_bak(DrugInfoNew drugInfoNew, String idx, List<String> stringBuilderx, int step, TrSafetyEvaluationDto trSafetyEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {
        // 不良反应描述
        String adverseReactionPrompt = "你作为一名专业的中药药师，需要根据" + drugInfoNew.getDrugName() + "说明书中【不良反应】以及【禁忌】原文信息，" +
                "分析一下说明书中【不良反应】以及【禁忌】两个模块的原文描述中，是否存在“尚不明确”等模糊字眼；或者直接显示为“无”。" +
                "并结合以下评分规则进行评分（单选）：" +
                "2分：不良反应、禁忌均描述清晰，不含“尚不明确”等模糊字眼" +
                "0分：不良反应、禁忌：其中一个或者两个描述不清晰，含有“尚不明确”等模糊字眼；或者直接显示为“无”。" +
                "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
                "【不良反应】：" + drugInfoNew.getAdverseReaction() + "\n" +
                "【禁忌】：" + drugInfoNew.getContraindications();
        String gpt = lxGptService.getGpt(adverseReactionPrompt, "", "2,0");
        String content = "";
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
        write("adverseReactionScore", trSafetyEvaluationDto.getAdverseReactionScore(), response, cacheDtos, "不良反应描述得分");
        write("adverseReactionContent", trSafetyEvaluationDto.getAdverseReactionContent(), response, cacheDtos, "不良反应描述");

        // 警告提示
        String warningNotePrompt = "你作为一名专业的中药药师，根据" + drugInfoNew.getDrugName() + "说明书中以下警示语以及注意事项原文信息，" +
                "【警告提示】：" + drugInfoNew.getDrugWarning() + "\n" +
                "【注意事项】：" + drugInfoNew.getNotes() +
                "分析一下两个模块中任意一个模块中，是否有提醒用户在某些特定情况下如果使用或者禁用药品，如：在某种情况下不宜或禁止使用本品，以避免加重病情或引发不良反应的相关内容，或者建议更换用药时间以减轻不良反应等。若有，给2分；若没有，给0分。 +\n" +
                "返回一个具体得分（直接返回一个分数，不要说明）\n" +
                "只要是具有能起到提醒用户作用的字样，就给2分。";

        String gpt1;
        if (!isNew){
             gpt1 = lxGptService.getGpt(warningNotePrompt, "", "2,0");
        }else {
            gpt1 = lxGptService.getGpt(warningNotePrompt, "qwen3-235b-a22b-instruct-2507", "2,0");
        }



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

        write("warningNoteScore", trSafetyEvaluationDto.getWarningNoteScore(), response, cacheDtos, "说明书中警示语或注意事项得分");
        write("warningNoteContent", trSafetyEvaluationDto.getWarningNoteContent(), response, cacheDtos, "说明书中警示语或注意事项");
        // 辅料
        if (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) && drugInfoNew.getIngredient().contains("辅料")) {
            trSafetyEvaluationDto.setExcipientScore(1.0);
            trSafetyEvaluationDto.setExcipient(drugInfoNew.getIngredient());
        } else {
            trSafetyEvaluationDto.setExcipientScore(0.0);
            trSafetyEvaluationDto.setExcipient("说明书无辅料相关内容");
        }
        write("excipientScore", trSafetyEvaluationDto.getExcipientScore(), response, cacheDtos, "辅料得分");
        write("excipient", trSafetyEvaluationDto.getExcipient(), response, cacheDtos, "辅料");

        // 安全性再评价
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
        strings1.add("联合");
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
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        if (literatureSearchHits.getTotalHits() > 0) {
            String string = "";
            boolean flag = false;
            boolean ismetaAndFlags = false;
            int count = 1;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {

                JSONObject jsonObject1 = new JSONObject();
                String title = literatureSearchHit.getContent().getTitle();
                String id = literatureSearchHit.getContent().getId();
                MongoLiterature paper = null;
                try {
                    paper = fineScreenFeign.paper(id);
                } catch (Exception e) {
                    log.error("id:{}", id);
                }

                if (ObjectUtil.isEmpty(paper)) {
                    continue;
                }
//                log.info("title:{},id:{},paper:{}", title, id, paper.getMethod());
//                if (StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) &&
//                        (literatureSearchHit.getContent().getSummary().contains("单中心") ||
//                                literatureSearchHit.getContent().getSummary().contains("多中心"))) {
//                    flag = true;
//                } else {
//                    if (literatureSearchHit.getContent().getLastNewType().contains("0")) {
//                        ismetaAndFlags = true;
//                    }
//                }
                string += "(" + count + ")《" + title + "》\n";
                jsonObject1.put("title", HtmlUtil.cleanHtmlTag(title));
                if (StringUtils.isNotEmpty(paper.getMethod())) {
                    string += "研究方法：" + paper.getMethod() + "\n";
                    // 去掉中括号
                    jsonObject1.put("content", paper.getMethod().replaceAll("\\[|\\]", ""));
                } else {
                    string += "摘要：" + literatureSearchHit.getContent().getSummary() + "\n";
                    jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                }
                jsonObjects.add(jsonObject1);
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
            String score;
            if (isNew){
                 score = lxGptService.getGpt(quear, "", "3,2,1");
            }else {
                 score = lxGptService.getGpt(quear, "qwen3-235b-a22b-instruct-2507", "3,2,1");
            }



            trSafetyEvaluationDto.setSafetyReevaluationContent(string);

            trSafetyEvaluationDto.setSafetyReevaluationScore(extractLastNumber(score));
        } else {
            trSafetyEvaluationDto.setSafetyReevaluationScore(0.0);
            trSafetyEvaluationDto.setSafetyReevaluationContent("未找到安全性相关内容");
        }
        write("safetyReevaluationScore", trSafetyEvaluationDto.getSafetyReevaluationScore(), response, cacheDtos, "安全性再评价得分");
        write("safetyReevaluationContent", jsonObjects, response, cacheDtos, "安全性再评价");

        trSafetyEvaluationDto.setSafetyInfoScore();
        write("safetyInfoScore", trSafetyEvaluationDto.getSafetyInfoScore(), response, cacheDtos, "安全性信息评价得分");

        // 人群限制
        // 儿童

        if (StringUtils.isEmpty(drugInfoNew.getChildrenMedicine())) {
            String txt = drugInfoUtil.getTxt(drugInfoNew, "儿童用药", "儿童", "");
            if (StringUtils.isNotEmpty(txt)) {
                drugInfoNew.setChildrenMedicine(txt);
            }
        }

        String childPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getChildrenMedicine() + "*****，" +
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
        JSONObject jsonObject1 = new JSONObject();
        if (isNew){
            jsonObject1 = gptAiUtils.executeGptPlus(childPrompt, "child", GptDemoEnum.GPT_DEMO_1.getContent(), "", "2,1.5,1,0.5");
        }else {
             jsonObject1 = lxGptService.executeGptPlus(childPrompt, "child", responseFormat, "gpt-5-mini", "2,1.5,1,0.5");
        }

        trSafetyEvaluationDto.setPediatricDrugUseScore(extractLastNumber(jsonObject1.getString("score")));
        trSafetyEvaluationDto.setPediatricDrugUseContent(jsonObject1.getString("content"));

        write("pediatricDrugUseScore", trSafetyEvaluationDto.getPediatricDrugUseScore(), response, cacheDtos, "安全性儿童得分");
        write("pediatricDrugUseContent", trSafetyEvaluationDto.getPediatricDrugUseContent(), response, cacheDtos, "安全性儿童");

        // 妊振期妇女

        if (StringUtils.isEmpty(drugInfoNew.getPregnant())) {
            String txt = drugInfoUtil.getTxt(drugInfoNew, "妊娠期妇女用药", "妊娠", "");
            if (StringUtils.isNotEmpty(txt)) {
                drugInfoNew.setPregnant(txt);
            }
        }

        String pregnancyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "请抽提出以上原文信息中所有与妊娠期妇女用药相关内容，总结出妊娠期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "妊娠期妇女可用；1分\n" +
                "妊娠期妇女慎用：0.5分\n" +
                "妊娠期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（2）没有明确妊娠期妇女相关信息时，认为是尚不明确。\n";
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content", "挑选出的关于孕妇及哺乳期妇女用药的相关内容");
        stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);

        JSONObject jsonObject2 = new JSONObject();
        if (isNew){
            jsonObject2 = gptAiUtils.executeGptPlus(pregnancyPrompt, "pregnancy", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
        }else {
             jsonObject2 = lxGptService.executeGptPlus(pregnancyPrompt, "pregnancy", responseFormat1, "gpt-5-mini", "1,0.5,0");
        }


        trSafetyEvaluationDto.setPregnancyDrugUseScore(extractLastNumber(jsonObject2.getString("score")));
        trSafetyEvaluationDto.setPregnancyDrugUseContent(jsonObject2.getString("content"));

        write("pregnancyDrugUseScore", trSafetyEvaluationDto.getPregnancyDrugUseScore(), response, cacheDtos, "妊娠期妇女得分");
        write("pregnancyDrugUseContent", trSafetyEvaluationDto.getPregnancyDrugUseContent(), response, cacheDtos, "妊娠期妇女");


        if (StringUtils.isEmpty(drugInfoNew.getLactation())) {
            String txt = drugInfoUtil.getTxt(drugInfoNew, "哺乳期妇女用药", "哺乳", "");
            if (StringUtils.isNotEmpty(txt)) {
                drugInfoNew.setLactation(txt);
            }
        }

        // 哺乳期妇女
        String lactationPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "请抽提出以上原文信息中所有与哺乳期妇女用药相关内容，总结出哺乳期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                "哺乳期妇女可用；1分\n" +
                "哺乳期妇女慎用：0.5分\n" +
                "哺乳期妇女禁用或尚不明确：0分\n" +
                "请注意：\n" +
                "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                "（2）没有明确哺乳期妇女相关信息时，认为是尚不明确，给0分。\n";
        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content", "挑选出的关于哺乳期妇女用药的相关内容");
        stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);

        JSONObject jsonObject3 = new JSONObject();
        if (isNew){
            jsonObject3 = gptAiUtils.executeGptPlus(lactationPrompt, "lactation", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
        }else {
            jsonObject3 = lxGptService.executeGptPlus(lactationPrompt, "lactation", responseFormat2, "gpt-5-mini", "1,0.5,0");
        }



        trSafetyEvaluationDto.setLactationDrugUseScore(extractLastNumber(jsonObject3.getString("score")));
        trSafetyEvaluationDto.setLactationDrugUseContent(jsonObject3.getString("content"));

        write("lactationDrugUseScore", trSafetyEvaluationDto.getLactationDrugUseScore(), response, cacheDtos, "哺乳期妇女得分");
        write("lactationDrugUseContent", trSafetyEvaluationDto.getLactationDrugUseContent(), response, cacheDtos, "哺乳期妇女");


        if (StringUtils.isEmpty(drugInfoNew.getDoseAdjustmentPatientsWithLiverDysfunction())) {

            String txt = drugInfoUtil.getTxt(drugInfoNew, "肝功能异常的用药", "肝", "");
            if (StringUtils.isNotEmpty(txt)) {
                drugInfoNew.setDoseAdjustmentPatientsWithLiverDysfunction(txt);
            }
        }

        if (!drugInfoNew.toString().contains("肝")) {
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent("尚不明确");
        } else {
            // 肝功能异常
            String liverPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与肝相关的内容，总结出肝功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                    "肝功能异常可用；1分\n" +
                    "肝功能异常慎用：0.5分\n" +
                    "肝功能异常禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（2）没有明确提及与肝相关信息时，认为是尚不明确，给0分。\n";
            HashMap<String, String> stringStringHashMap3 = new HashMap<>();
            stringStringHashMap3.put("content", "挑选出的关于肝功能异常用药的相关内容");
            stringStringHashMap3.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat3 = getResponseFormat(stringStringHashMap3);

            JSONObject jsonObject4 = new JSONObject();
            if (isNew){
                jsonObject4 = gptAiUtils.executeGptPlus(liverPrompt, "liver", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
            }else {
                jsonObject4 = lxGptService.executeGptPlus(liverPrompt, "liver", responseFormat3, "", "1,0.5,0");
            }

            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(extractLastNumber(jsonObject4.getString("score")));
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent(jsonObject4.getString("content"));
        }

        write("liverDysfunctionDrugUseScore", trSafetyEvaluationDto.getLiverDysfunctionDrugUseScore(), response, cacheDtos, "肝功能异常得分");
        write("liverDysfunctionDrugUseContent", trSafetyEvaluationDto.getLiverDysfunctionDrugUseContent(), response, cacheDtos, "肝功能异常");


        if (StringUtils.isEmpty(drugInfoNew.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
            String txt = drugInfoUtil.getTxt(drugInfoNew, "肾功能异常的用药", "肾", "");
            if (StringUtils.isNotEmpty(txt)) {
                drugInfoNew.setDoseAdjustmentPatientsWithRenalInsufficiency(txt);
            }
        }


        if (!drugInfoNew.toString().contains("肾")) {
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(0.0);
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent("尚不明确");
        } else {

            // 肾功能异常
            String kidneyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与肾相关的内容，总结出肾功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                    "肾功能异常可用；1分\n" +
                    "肾功能异常慎用：0.5分\n" +
                    "肾功能异常禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（2）没有明确提及与肾相关信息时，认为是尚不明确，给0分。\n";
            HashMap<String, String> stringStringHashMap4 = new HashMap<>();
            stringStringHashMap4.put("content", "挑选出的关于肾功能异常用药的相关内容");
            stringStringHashMap4.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat4 = getResponseFormat(stringStringHashMap4);
            JSONObject jsonObject5 = new JSONObject();
            if (isNew){
                jsonObject5 = gptAiUtils.executeGptPlus(kidneyPrompt, "kidney", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
            }else {
                jsonObject5 = lxGptService.executeGptPlus(kidneyPrompt, "kidney", responseFormat4, "", "1,0.5,0");
            }

            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(extractLastNumber(jsonObject5.getString("score")));
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent(jsonObject5.getString("content"));
        }
        write("kidneyDysfunctionDrugUseScore", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseScore(), response, cacheDtos, "肾功能异常得分");
        write("kidneyDysfunctionDrugUseContent", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseContent(), response, cacheDtos, "肾功能异常");


        if (!drugInfoNew.toString().contains("运动员")) {
            trSafetyEvaluationDto.setAthleteDrugUseScore(1.0);
            trSafetyEvaluationDto.setAthleteDrugUseContent("未明确提及运动员相关信息，认为运动员可用");
        } else {
            // 运动
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

            JSONObject jsonObject6 = new JSONObject();
            if (isNew){
                jsonObject6 = gptAiUtils.executeGptPlus(athletePrompt, "athlete", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
            }else {
                jsonObject6 = lxGptService.executeGptPlus(athletePrompt, "athlete", responseFormat5, "", "1,0");
            }
            trSafetyEvaluationDto.setAthleteDrugUseScore(extractLastNumber(jsonObject6.getString("score")));
            trSafetyEvaluationDto.setAthleteDrugUseContent(jsonObject6.getString("content"));
        }
        write("athleteDrugUseScore", trSafetyEvaluationDto.getAthleteDrugUseScore(), response, cacheDtos, "运动员得分");
        write("athleteDrugUseContent", trSafetyEvaluationDto.getAthleteDrugUseContent(), response, cacheDtos, "运动员");
        trSafetyEvaluationDto.setCrowdRestrictionScore();
        write("crowdRestrictionScore", trSafetyEvaluationDto.getCrowdRestrictionScore(), response, cacheDtos, "人群限制总得分");

        // 不良反应分级
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

        JSONObject jsonObject7 = new JSONObject();
        if (isNew){
            jsonObject7 = gptAiUtils.executeGptPlus(adverPrompt, "adver", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,1");
        }else {
            jsonObject7 = lxGptService.executeGptPlus(adverPrompt, "adver", responseFormat6, "", "5,3,1");
        }

        trSafetyEvaluationDto.setAdverseReactionStratificationScore(extractLastNumber(jsonObject7.getString("score")));
        trSafetyEvaluationDto.setAdverseReactionStratificationContent(jsonObject7.getString("content"));

        write("adverseReactionStratificationScore", trSafetyEvaluationDto.getAdverseReactionStratificationScore(), response, cacheDtos, "不良反应分级得分");
        write("adverseReactionStratificationContent", trSafetyEvaluationDto.getAdverseReactionStratificationContent(), response, cacheDtos, "不良反应分级");
        trSafetyEvaluationDto.setCrowdRestrictionScore();
        trSafetyEvaluationDto.setTotalScore();
        write("safetyEvaluationTotalScore", trSafetyEvaluationDto.getTotalScore(), response, cacheDtos, "安全评价总得分");


        return step;

    }


    public int getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew, String idx, List<String> stringBuilderx, int step, TrSafetyEvaluationDto trSafetyEvaluationDto, HttpServletResponse response, List<CacheDto> cacheDtos) {
        // 初始化信号量控制并发
        Semaphore semaphore = new Semaphore(5);

        // 并行处理不良反应描述
        CompletableFuture<String> adverseReactionFuture = CompletableFuture.supplyAsync(() -> {
            String adverseReactionPrompt = "你作为一名专业的中药药师，需要根据" + drugInfoNew.getDrugName() + "说明书中【不良反应】以及【禁忌】原文信息，" +
                    "分析一下说明书中【不良反应】以及【禁忌】两个模块的原文描述中，是否存在“尚不明确”等模糊字眼；或者直接显示为“无”。" +
                    "并结合以下评分规则进行评分（单选）：" +
                    "2分：不良反应、禁忌均描述清晰，不含“尚不明确”等模糊字眼" +
                    "0分：不良反应、禁忌：其中一个或者两个描述不清晰，含有“尚不明确”等模糊字眼；或者直接显示为“无”。" +
                    "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
                    "【不良反应】：" + drugInfoNew.getAdverseReaction() + "\n" +
                    "【禁忌】：" + drugInfoNew.getContraindications();
            try {
                semaphore.acquire();
                return lxGptService.getGpt(adverseReactionPrompt, "", "2,0");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "0";
            } finally {
                semaphore.release();
            }
        });

        // 并行处理警告提示
        CompletableFuture<String> warningNoteFuture = CompletableFuture.supplyAsync(() -> {
            String warningNotePrompt = "你作为一名专业的中药药师，根据" + drugInfoNew.getDrugName() + "说明书中以下警示语以及注意事项原文信息，" +
                    "【警告提示】：" + drugInfoNew.getDrugWarning() + "\n" +
                    "【注意事项】：" + drugInfoNew.getNotes() +
                    "分析一下两个模块中任意一个模块中，是否有提醒用户在某些特定情况下如果使用或者禁用药品，如：在某种情况下不宜或禁止使用本品，以避免加重病情或引发不良反应的相关内容，或者建议更换用药时间以减轻不良反应等。若有，给2分；若没有，给0分。 +\n" +
                    "返回一个具体得分（直接返回一个分数，不要说明）\n" +
                    "只要是具有能起到提醒用户作用的字样，就给2分。";
            try {
                semaphore.acquire();
                if (!isNew){
                    return lxGptService.getGpt(warningNotePrompt, "", "2,0");
                }else {
                    return lxGptService.getGpt(warningNotePrompt, "qwen3-235b-a22b-instruct-2507", "2,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "0";
            } finally {
                semaphore.release();
            }
        });

        // 并行处理安全性再评价
        CompletableFuture<SearchHits<Literature>> literatureSearchHitsFuture = CompletableFuture.supplyAsync(() -> {
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
            strings1.add("联合");
            StringBuilder stringBuilder3 = PromptUtil.montageForPaper(stringBuilder2, strings1, "标题");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("query", stringBuilder3.toString());
            jsonObject.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObject);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);

            BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
            boolQueryBuilder.must().add(wrapperQueryBuilder);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            return this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        });

        // 并行处理儿童用药
        CompletableFuture<JSONObject> childFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(drugInfoNew.getChildrenMedicine())) {
                String txt = drugInfoUtil.getTxt(drugInfoNew, "儿童用药", "儿童", "");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfoNew.setChildrenMedicine(txt);
                }
            }

            String childPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getChildrenMedicine() + "*****，" +
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
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(childPrompt, "child", GptDemoEnum.GPT_DEMO_1.getContent(), "", "2,1.5,1,0.5");
                }else {
                    return lxGptService.executeGptPlus(childPrompt, "child", responseFormat, "gpt-5-mini", "2,1.5,1,0.5");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理妊娠期妇女用药
        CompletableFuture<JSONObject> pregnancyFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(drugInfoNew.getPregnant())) {
                String txt = drugInfoUtil.getTxt(drugInfoNew, "妊娠期妇女用药", "妊娠", "");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfoNew.setPregnant(txt);
                }
            }

            String pregnancyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与妊娠期妇女用药相关内容，总结出妊娠期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                    "妊娠期妇女可用；1分\n" +
                    "妊娠期妇女慎用：0.5分\n" +
                    "妊娠期妇女禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（2）没有明确妊娠期妇女相关信息时，认为是尚不明确。\n";
            HashMap<String, String> stringStringHashMap1 = new HashMap<>();
            stringStringHashMap1.put("content", "挑选出的关于孕妇及哺乳期妇女用药的相关内容");
            stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(pregnancyPrompt, "pregnancy", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
                }else {
                    return lxGptService.executeGptPlus(pregnancyPrompt, "pregnancy", responseFormat1, "gpt-5-mini", "1,0.5,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理哺乳期妇女用药
        CompletableFuture<JSONObject> lactationFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(drugInfoNew.getLactation())) {
                String txt = drugInfoUtil.getTxt(drugInfoNew, "哺乳期妇女用药", "哺乳", "");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfoNew.setLactation(txt);
                }
            }

            // 哺乳期妇女
            String lactationPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "请抽提出以上原文信息中所有与哺乳期妇女用药相关内容，总结出哺乳期妇女是否可用，并结合以下评分规则给出最终得分：\n" +
                    "哺乳期妇女可用；1分\n" +
                    "哺乳期妇女慎用：0.5分\n" +
                    "哺乳期妇女禁用或尚不明确：0分\n" +
                    "请注意：\n" +
                    "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                    "（2）没有明确哺乳期妇女相关信息时，认为是尚不明确，给0分。\n";
            HashMap<String, String> stringStringHashMap2 = new HashMap<>();
            stringStringHashMap2.put("content", "挑选出的关于哺乳期妇女用药的相关内容");
            stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(lactationPrompt, "lactation", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
                }else {
                    return lxGptService.executeGptPlus(lactationPrompt, "lactation", responseFormat2, "gpt-5-mini", "1,0.5,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理肝功能异常用药
        CompletableFuture<JSONObject> liverFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(drugInfoNew.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                String txt = drugInfoUtil.getTxt(drugInfoNew, "肝功能异常的用药", "肝", "");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfoNew.setDoseAdjustmentPatientsWithLiverDysfunction(txt);
                }
            }

            if (!drugInfoNew.toString().contains("肝")) {
                JSONObject result = new JSONObject();
                result.put("score", "0");
                result.put("content", "尚不明确");
                return result;
            } else {
                // 肝功能异常
                String liverPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                        "请抽提出以上原文信息中所有与肝相关的内容，总结出肝功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                        "肝功能异常可用；1分\n" +
                        "肝功能异常慎用：0.5分\n" +
                        "肝功能异常禁用或尚不明确：0分\n" +
                        "请注意：\n" +
                        "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                        "（2）没有明确提及与肝相关信息时，认为是尚不明确，给0分。\n";
                HashMap<String, String> stringStringHashMap3 = new HashMap<>();
                stringStringHashMap3.put("content", "挑选出的关于肝功能异常用药的相关内容");
                stringStringHashMap3.put("score", "打分（务必是数字:int或者double类型）");
                JSONObject responseFormat3 = getResponseFormat(stringStringHashMap3);
                try {
                    semaphore.acquire();
                    if (isNew){
                        return gptAiUtils.executeGptPlus(liverPrompt, "liver", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
                    }else {
                        return lxGptService.executeGptPlus(liverPrompt, "liver", responseFormat3, "", "1,0.5,0");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    JSONObject result = new JSONObject();
                    result.put("score", "0");
                    result.put("content", "尚不明确");
                    return result;
                } finally {
                    semaphore.release();
                }
            }
        });

        // 并行处理肾功能异常用药
        CompletableFuture<JSONObject> kidneyFuture = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(drugInfoNew.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                String txt = drugInfoUtil.getTxt(drugInfoNew, "肾功能异常的用药", "肾", "");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfoNew.setDoseAdjustmentPatientsWithRenalInsufficiency(txt);
                }
            }

            if (!drugInfoNew.toString().contains("肾")) {
                JSONObject result = new JSONObject();
                result.put("score", "0");
                result.put("content", "尚不明确");
                return result;
            } else {
                // 肾功能异常
                String kidneyPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                        "请抽提出以上原文信息中所有与肾相关的内容，总结出肾功能异常是否可用，并结合以下评分规则给出最终得分：\n" +
                        "肾功能异常可用；1分\n" +
                        "肾功能异常慎用：0.5分\n" +
                        "肾功能异常禁用或尚不明确：0分\n" +
                        "请注意：\n" +
                        "（1）当出现“在医生指导下使用”时，算作可用，给1分；\n" +
                        "（2）没有明确提及与肾相关信息时，认为是尚不明确，给0分。\n";
                HashMap<String, String> stringStringHashMap4 = new HashMap<>();
                stringStringHashMap4.put("content", "挑选出的关于肾功能异常用药的相关内容");
                stringStringHashMap4.put("score", "打分（务必是数字:int或者double类型）");
                JSONObject responseFormat4 = getResponseFormat(stringStringHashMap4);
                try {
                    semaphore.acquire();
                    if (isNew){
                        return gptAiUtils.executeGptPlus(kidneyPrompt, "kidney", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0.5,0");
                    }else {
                        return lxGptService.executeGptPlus(kidneyPrompt, "kidney", responseFormat4, "", "1,0.5,0");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    JSONObject result = new JSONObject();
                    result.put("score", "0");
                    result.put("content", "尚不明确");
                    return result;
                } finally {
                    semaphore.release();
                }
            }
        });

        // 并行处理运动员用药
        CompletableFuture<JSONObject> athleteFuture = CompletableFuture.supplyAsync(() -> {
            if (!drugInfoNew.toString().contains("运动员")) {
                JSONObject result = new JSONObject();
                result.put("score", "1");
                result.put("content", "未明确提及运动员相关信息，认为运动员可用");
                return result;
            } else {
                // 运动
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
                try {
                    semaphore.acquire();
                    if (isNew){
                        return gptAiUtils.executeGptPlus(athletePrompt, "athlete", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
                    }else {
                        return lxGptService.executeGptPlus(athletePrompt, "athlete", responseFormat5, "", "1,0");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    JSONObject result = new JSONObject();
                    result.put("score", "1");
                    result.put("content", "未明确提及运动员相关信息，认为运动员可用");
                    return result;
                } finally {
                    semaphore.release();
                }
            }
        });

        // 并行处理不良反应分级
        CompletableFuture<JSONObject> adverseReactionStratificationFuture = CompletableFuture.supplyAsync(() -> {
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
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(adverPrompt, "adver", GptDemoEnum.GPT_DEMO_1.getContent(), "", "5,3,1");
                }else {
                    return lxGptService.executeGptPlus(adverPrompt, "adver", responseFormat6, "", "5,3,1");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 等待所有并行任务完成并处理结果
        try {
            // 处理不良反应描述结果
            String gpt = adverseReactionFuture.get();
            String content = "";
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
            write("adverseReactionScore", trSafetyEvaluationDto.getAdverseReactionScore(), response, cacheDtos, "不良反应描述得分");
            write("adverseReactionContent", trSafetyEvaluationDto.getAdverseReactionContent(), response, cacheDtos, "不良反应描述");

            // 处理警告提示结果
            String gpt1 = warningNoteFuture.get();
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
            write("warningNoteScore", trSafetyEvaluationDto.getWarningNoteScore(), response, cacheDtos, "说明书中警示语或注意事项得分");
            write("warningNoteContent", trSafetyEvaluationDto.getWarningNoteContent(), response, cacheDtos, "说明书中警示语或注意事项");

            // 处理辅料
            if (StringUtils.isNotEmpty(drugInfoNew.getIngredient()) && drugInfoNew.getIngredient().contains("辅料")) {
                trSafetyEvaluationDto.setExcipientScore(1.0);
                trSafetyEvaluationDto.setExcipient(drugInfoNew.getIngredient());
            } else {
                trSafetyEvaluationDto.setExcipientScore(0.0);
                trSafetyEvaluationDto.setExcipient("说明书无辅料相关内容");
            }
            write("excipientScore", trSafetyEvaluationDto.getExcipientScore(), response, cacheDtos, "辅料得分");
            write("excipient", trSafetyEvaluationDto.getExcipient(), response, cacheDtos, "辅料");

            // 处理安全性再评价结果
            SearchHits<Literature> literatureSearchHits = literatureSearchHitsFuture.get();
            ArrayList<JSONObject> jsonObjects = new ArrayList<>();
            if (literatureSearchHits.getTotalHits() > 0) {
                String string = "";
                boolean flag = false;
                boolean ismetaAndFlags = false;
                int count = 1;
                for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                    JSONObject jsonObject1 = new JSONObject();
                    String title = literatureSearchHit.getContent().getTitle();
                    String id = literatureSearchHit.getContent().getId();
                    MongoLiterature paper = null;
                    try {
                        paper = fineScreenFeign.paper(id);
                    } catch (Exception e) {
                        log.error("id:{}", id);
                    }

                    if (ObjectUtil.isEmpty(paper)) {
                        continue;
                    }
                    string += "(" + count + ")《" + title + "》\n";
                    jsonObject1.put("title", HtmlUtil.cleanHtmlTag(title));
                    if (StringUtils.isNotEmpty(paper.getMethod())) {
                        string += "研究方法：" + paper.getMethod() + "\n";
                        // 去掉中括号
                        jsonObject1.put("content", paper.getMethod().replaceAll("\\[|\\]", ""));
                    } else {
                        string += "摘要：" + literatureSearchHit.getContent().getSummary() + "\n";
                        jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                    }
                    jsonObjects.add(jsonObject1);
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
                String score;
                if (isNew){
                    score = lxGptService.getGpt(quear, "", "3,2,1");
                }else {
                    score = lxGptService.getGpt(quear, "qwen3-235b-a22b-instruct-2507", "3,2,1");
                }

                trSafetyEvaluationDto.setSafetyReevaluationContent(string);
                trSafetyEvaluationDto.setSafetyReevaluationScore(extractLastNumber(score));
            } else {
                trSafetyEvaluationDto.setSafetyReevaluationScore(0.0);
                trSafetyEvaluationDto.setSafetyReevaluationContent("未找到安全性相关内容");
            }
            write("safetyReevaluationScore", trSafetyEvaluationDto.getSafetyReevaluationScore(), response, cacheDtos, "安全性再评价得分");
            write("safetyReevaluationContent", jsonObjects, response, cacheDtos, "安全性再评价");

            trSafetyEvaluationDto.setSafetyInfoScore();
            write("safetyInfoScore", trSafetyEvaluationDto.getSafetyInfoScore(), response, cacheDtos, "安全性信息评价得分");

            // 处理儿童用药结果
            JSONObject jsonObject1 = childFuture.get();
            trSafetyEvaluationDto.setPediatricDrugUseScore(extractLastNumber(jsonObject1.getString("score")));
            trSafetyEvaluationDto.setPediatricDrugUseContent(jsonObject1.getString("content"));
            write("pediatricDrugUseScore", trSafetyEvaluationDto.getPediatricDrugUseScore(), response, cacheDtos, "安全性儿童得分");
            write("pediatricDrugUseContent", trSafetyEvaluationDto.getPediatricDrugUseContent(), response, cacheDtos, "安全性儿童");

            // 处理妊娠期妇女用药结果
            JSONObject jsonObject2 = pregnancyFuture.get();
            trSafetyEvaluationDto.setPregnancyDrugUseScore(extractLastNumber(jsonObject2.getString("score")));
            trSafetyEvaluationDto.setPregnancyDrugUseContent(jsonObject2.getString("content"));
            write("pregnancyDrugUseScore", trSafetyEvaluationDto.getPregnancyDrugUseScore(), response, cacheDtos, "妊娠期妇女得分");
            write("pregnancyDrugUseContent", trSafetyEvaluationDto.getPregnancyDrugUseContent(), response, cacheDtos, "妊娠期妇女");

            // 处理哺乳期妇女用药结果
            JSONObject jsonObject3 = lactationFuture.get();
            trSafetyEvaluationDto.setLactationDrugUseScore(extractLastNumber(jsonObject3.getString("score")));
            trSafetyEvaluationDto.setLactationDrugUseContent(jsonObject3.getString("content"));
            write("lactationDrugUseScore", trSafetyEvaluationDto.getLactationDrugUseScore(), response, cacheDtos, "哺乳期妇女得分");
            write("lactationDrugUseContent", trSafetyEvaluationDto.getLactationDrugUseContent(), response, cacheDtos, "哺乳期妇女");

            // 处理肝功能异常用药结果
            JSONObject jsonObject4 = liverFuture.get();
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(extractLastNumber(jsonObject4.getString("score")));
            trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent(jsonObject4.getString("content"));
            write("liverDysfunctionDrugUseScore", trSafetyEvaluationDto.getLiverDysfunctionDrugUseScore(), response, cacheDtos, "肝功能异常得分");
            write("liverDysfunctionDrugUseContent", trSafetyEvaluationDto.getLiverDysfunctionDrugUseContent(), response, cacheDtos, "肝功能异常");

            // 处理肾功能异常用药结果
            JSONObject jsonObject5 = kidneyFuture.get();
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(extractLastNumber(jsonObject5.getString("score")));
            trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent(jsonObject5.getString("content"));
            write("kidneyDysfunctionDrugUseScore", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseScore(), response, cacheDtos, "肾功能异常得分");
            write("kidneyDysfunctionDrugUseContent", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseContent(), response, cacheDtos, "肾功能异常");

            // 处理运动员用药结果
            JSONObject jsonObject6 = athleteFuture.get();
            trSafetyEvaluationDto.setAthleteDrugUseScore(extractLastNumber(jsonObject6.getString("score")));
            trSafetyEvaluationDto.setAthleteDrugUseContent(jsonObject6.getString("content"));
            write("athleteDrugUseScore", trSafetyEvaluationDto.getAthleteDrugUseScore(), response, cacheDtos, "运动员得分");
            write("athleteDrugUseContent", trSafetyEvaluationDto.getAthleteDrugUseContent(), response, cacheDtos, "运动员");

            trSafetyEvaluationDto.setCrowdRestrictionScore();
            write("crowdRestrictionScore", trSafetyEvaluationDto.getCrowdRestrictionScore(), response, cacheDtos, "人群限制总得分");

            // 处理不良反应分级结果
            JSONObject jsonObject7 = adverseReactionStratificationFuture.get();
            trSafetyEvaluationDto.setAdverseReactionStratificationScore(extractLastNumber(jsonObject7.getString("score")));
            trSafetyEvaluationDto.setAdverseReactionStratificationContent(jsonObject7.getString("content"));
            write("adverseReactionStratificationScore", trSafetyEvaluationDto.getAdverseReactionStratificationScore(), response, cacheDtos, "不良反应分级得分");
            write("adverseReactionStratificationContent", trSafetyEvaluationDto.getAdverseReactionStratificationContent(), response, cacheDtos, "不良反应分级");

            trSafetyEvaluationDto.setCrowdRestrictionScore();
            trSafetyEvaluationDto.setTotalScore();
            write("safetyEvaluationTotalScore", trSafetyEvaluationDto.getTotalScore(), response, cacheDtos, "安全评价总得分");

        } catch (Exception e) {
            log.error("Error processing safety evaluation", e);
        }

        return step;
    }






    // 技术评价
    public int getTrTechnologyEvaluationDto_bak(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrTechnologyEvaluationDto trTechnologyEvaluationDto, HttpServletResponse response, JSONObject jsonObjectMar, List<CacheDto> cacheDtos) {

        // 频次
        String prompt = "你作为一名专业的中成药执业药师，非常了解中成药相关用法用量，特别是中成药的给药频次。" +
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
                "（2）当用法用量中没有明确给药次数时，给0分。如：“每日数次。”或者“根据症状适当增减。”\n";

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("content", "药品用药频次相关的内容");
        stringStringHashMap.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        JSONObject jsonObject = new JSONObject();

        if (isNew){
            jsonObject = gptAiUtils.executeGptPlus(prompt, "frequency", GptDemoEnum.GPT_DEMO_1.getContent(), "","2,1.5,1,0");
        }else {
            jsonObject = lxGptService.executeGptPlus(prompt, "frequency", responseFormat, "", "2,1.5,1,0");
        }

        trTechnologyEvaluationDto.setAdministrationFrequencyScore(extractLastNumber(jsonObject.getString("score")));
        trTechnologyEvaluationDto.setAdministrationFrequencyContent(jsonObject.getString("content"));
        write("administrationFrequencyScore", trTechnologyEvaluationDto.getAdministrationFrequencyScore(), response, cacheDtos, "频次得分");
        write("administrationFrequencyContent", trTechnologyEvaluationDto.getAdministrationFrequencyContent(), response, cacheDtos, "频次");


        // 规格包装使用量抽取
        // todo
        prompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****&&&【用法用量】：" + drugInfoNew.getUsageAndDosage() + "&&&。【规格】：" + drugInfoNew.getSpecifications() +
                "。&&&【包装】：" + drugInfoNew.getPack() + "*****，" +
                "请参照下方我提供的示例，抽取上方所给出资料中对应的内容（无对应内容返回空字段即可），对应字段如下：" +
                "packagQuantity:包装数值；packagQuantityUnit：包装单位；singleDoseUsage：单次用药量(请抽取临床常用单次剂量，若单次用药剂量为区间范围数值时（如每次1-2片），取数值大的那个（取2）)；singleDoseUsageUnit：单次用药单位（尽量与规格单位统一）" +
                "medicationFrequency：用药频率；medicationFrequencyUnit：用药频率单位（一般为：次/日，也可为：月/次）；miniQuantity：规格数值（提供的规格中可能存在多种不同的单位，如“每瓶装2g”，这里面既有单位“瓶”，又有单位“g”，在提取规格的数值时，需要根据单次用量的单位进行选取（注意：提取的规格的数值的所属单位必须与单次用量的单位相同才行）" +
                "\nminiQuantityUnit:规格单位（尽量与单次用量统一）" +
                "【用法用量】含服。⼀次4-6丸，⼀⽇ 3次；急性发作时，⼀次10-15丸。【包装】瓷瓶装，50 丸× 3 瓶。【规格】每丸重 40 mg。" +
                "请返回以下内容：" +
                "    \"packagQuantity\":150,\n" +
                "    \"packagQuantityUnit\":\"丸\",\n" +
                "    \"singleDoseUsage\":6,\n" +
                "    \"singleDoseUsageUnit\":\"丸\",\n" +
                "    \"medicationFrequency\":3,\n" +
                "    \"medicationFrequencyUnit\":\"次/日\",\n" +
                "    \"miniQuantity\":\"1\"\n" +
                "    \"miniQuantityUnit\":\"丸\"\n" +
                "\n" +
                "}   注意：以下内容只针对miniQuantity字段：根据我提供的药品说明书中的【规格】以及【用法用量】原文，将药品规格信息提取出来。提取规则最好是规格与单次用量单位相同，若未提供单次用量，请按照你自己的理解进行提取。\n" +
                "以下是我提供给你的几个示例，你可以按照我提供的示例结果相关思路来处理。\n" +
                "\n" +
                "示例1：\n" +
                "【规格】(1)5×7cm (2)7×10cm\n" +
                "【用法用量】无\n" +
                "需要提取的规格结果为：1贴（只有贴剂规格才是cm×cm，显示的是膏药的大小）\n" +
                "\n" +
                "示例2：\n" +
                "【规格】每丸重60mg(相当于银杏叶提取物16mg)\n" +
                "【用法用量】口服。一次5丸，一日3次，或遵医嘱。\n" +
                "需要提取的规格结果为：1丸\n" +
                "\n" +
                "示例3：\n" +
                "【规格】每袋(瓶)装2g \n" +
                "【用法用量】口服。一次2g，一日2次。\n" +
                "需要提取的规格结果为：2g\n" +
                "\n" +
                "示例4：\n" +
                "【规格】每1ml相当于饮片2.14g\n" +
                "【用法用量】口服。一次20ml,一日3次\n" +
                "需要提取的规格结果为：1ml\n" +
                "\n" +
                "示例5：\n" +
                "【规格】每瓶装250ml\n" +
                "【用法用量】口服,一次10毫升,一日3次。\n" +
                "需要提取的规格结果为：250ml";

        HashMap<String, String> stringStringHashMapx = new HashMap<>();
        stringStringHashMapx.put("packagQuantity", "包装规格");
        stringStringHashMapx.put("packagQuantityUnit", "包装规格单位");
        stringStringHashMapx.put("singleDoseUsage", "单次剂量");
        stringStringHashMapx.put("singleDoseUsageUnit", "单次剂量单位");
        stringStringHashMapx.put("medicationFrequency", "用药频率");
        stringStringHashMapx.put("medicationFrequencyUnit", "用药频率单位");
        stringStringHashMapx.put("miniQuantity", "包装");
        stringStringHashMapx.put("miniQuantityUnit", "包装单位");
        JSONObject responseFormatx = getResponseFormat(stringStringHashMapx);
        JSONObject prompt1 = lxGptService.executeGptPlus(prompt, "prompt", responseFormatx, "", "");
        // 包装规格
        String packagQuantity = prompt1.getString("packagQuantity") + prompt1.getString("packagQuantityUnit");
        // 单次用药计量
        String singleDose = prompt1.getString("singleDoseUsage") + prompt1.getString("singleDoseUsageUnit");
        // 频率
        String medicationFrequency = prompt1.getString("medicationFrequency") + prompt1.getString("medicationFrequencyUnit");
//        //最小包装
//         String

        String minPackag = drugInfoNew.getNumber();
        if (StringUtils.isEmpty(minPackag)) {
            minPackag = prompt1.getString("miniQuantity") + prompt1.getString("miniQuantityUnit");
        }

        // 包装规格计算
        double packagingSpecification = getPackagingSpecification(packagQuantity, singleDose, medicationFrequency, drugInfoNew.getPack(), drugInfoNew.getUsageAndDosage());
        if (packagingSpecification != 0) {
            boolean doubleInteger = isDoubleInteger(packagingSpecification);
            if (doubleInteger) {
                write("packagingSpecificationScore", 1, response, cacheDtos, "包装规格得分");
                trTechnologyEvaluationDto.setPackagingSpecificationScore(1.00);
                write("packagingSpecificationOption", "1", response, cacheDtos, "包装规格选项");
            } else {
                write("packagingSpecificationScore", 0.5, response, cacheDtos, "包装规格得分");
                trTechnologyEvaluationDto.setPackagingSpecificationScore(0.50);
                write("packagingSpecificationOption", "2", response, cacheDtos, "包装规格选项");
            }
        } else {
            write("packagingSpecificationScore", 0, response, cacheDtos, "包装规格得分");

            write("packagingSpecificationOption", "", response, cacheDtos, "包装规格选项");
        }

        JSONObject jsonObject4 = new JSONObject();
        jsonObject4.put("packagQuantity", packagQuantity);
        jsonObject4.put("singleDose", singleDose);
        jsonObject4.put("medicationFrequency", medicationFrequency);
        // 用法用量
        jsonObject4.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
        // 包装
        jsonObject4.put("pack", drugInfoNew.getPack());

        jsonObjectMar.put("singleDose", singleDose);
        jsonObjectMar.put("medicationFrequency", medicationFrequency);
        jsonObjectMar.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
        jsonObjectMar.put("price", "");

        write("packagingSpecificationJson", jsonObject4, response, cacheDtos, "包装规格信息");


//        trTechnologyEvaluationDto.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");

//        write("packagingSpecificationScore", trTechnologyEvaluationDto.getPackagingSpecificationScore(), response);
//        write("packagingSpecificationOption","", response);
//        write("largePackageAdoptionScore", trTechnologyEvaluationDto.getLargePackageAdoptionScore(), response);

//        //大包装
//        //todo 先直接赋值
        trTechnologyEvaluationDto.setLargePackageAdoptionScore(0.0);
//        trTechnologyEvaluationDto.setLargePackageAdoptionOption("最小包装使用人次数高于对照药");

        write("largePackageAdoptionScore", trTechnologyEvaluationDto.getLargePackageAdoptionScore(), response, cacheDtos, "采用大包装得分");
        write("largePackageAdoptionOption", "", response, cacheDtos, "采用大包装选项");
        JSONObject jsonObject5 = new JSONObject();
        jsonObject5.put("packagQuantity", packagQuantity);
        jsonObject5.put("singleDose", singleDose);
        // 用法用量
        jsonObject5.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
        // 包装
        jsonObject5.put("pack", drugInfoNew.getPack());


        write("largePackageAdoptionJson", jsonObject5, response, cacheDtos, "采用大包装信息");


        double singleDose1 = getSingleDose(minPackag, singleDose, drugInfoNew.getUsageAndDosage(), drugInfoNew.getSpecifications());
        if (singleDose1 != 0.0) {

            if (singleDose1 == 1) {
                trTechnologyEvaluationDto.setSingleDoseScore(1.00);
                trTechnologyEvaluationDto.setSingleDoseOption("1");

            } else if (singleDose1 > 1) {
                trTechnologyEvaluationDto.setSingleDoseScore(0.8);
                trTechnologyEvaluationDto.setSingleDoseOption("2");
            } else if (singleDose1 < 1) {
                trTechnologyEvaluationDto.setSingleDoseScore(0.5);
                trTechnologyEvaluationDto.setSingleDoseOption("3");
            }
        } else {

            trTechnologyEvaluationDto.setSingleDoseScore(1.00);
            trTechnologyEvaluationDto.setSingleDoseOption("");
        }

//        //单剂量
//        //todo 先直接赋值
//        trTechnologyEvaluationDto.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
//        trTechnologyEvaluationDto.setSingleDoseScore(0.0);


        write("singleDoseScore", trTechnologyEvaluationDto.getSingleDoseScore(), response, cacheDtos, "临床常用单次用量与药品规格的适配性得分");

        write("singleDoseOption", trTechnologyEvaluationDto.getSingleDoseOption(), response, cacheDtos, "临床常用单次用量与药品规格适配选项");

        JSONObject jsonObject6 = new JSONObject();
        // 规格
        jsonObject6.put("miniQuantity", minPackag);
        jsonObject6.put("singleDose", singleDose);
        // 用法用量
        jsonObject6.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
        // 包装
        jsonObject6.put("specifications", drugInfoNew.getSpecifications());
        write("singleDoseJson", jsonObject6, response, cacheDtos, "临床常用单次用量与药品规格信息");
        // 疗程
        String coursePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                "1.首先，根据我提供的内容，先判断是否有“疗程”相关原文内容，若有，请帮我挑选出药品疗程相关的内容；若没有相关的则返回暂无疗程相关内容 +\n" +
                "2.结合以下评分规则，给出药品使用疗程的最终得分：（单选）\n" +
                "疗程有明确限定：1分；\n" +
                "未提及疗程：0分。\n";
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("content", "药品疗程相关的内容");
        stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
        JSONObject jsonObject1 = new JSONObject();
        if (isNew){
            jsonObject1 = gptAiUtils.executeGptPlus(coursePrompt, "course", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
        }else {
            jsonObject1 = lxGptService.executeGptPlus(coursePrompt, "course", responseFormat1, "", "1,0");
        }

        trTechnologyEvaluationDto.setCourseOfTreatmentScore(extractLastNumber(jsonObject1.getString("score")));
        trTechnologyEvaluationDto.setCourseOfTreatmentContent(jsonObject1.getString("content"));
        write("courseOfTreatmentScore", trTechnologyEvaluationDto.getCourseOfTreatmentScore(), response, cacheDtos, "疗程得分");
        write("courseOfTreatmentContent", trTechnologyEvaluationDto.getCourseOfTreatmentContent(), response, cacheDtos, "疗程内容");


        // 存储
        String storagePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getStorage() + "*****，" +
                "作为一名专业的药师，请根据说明书原文内容，结合以下打分规则进行评分。\n" +
                "1分：常温贮藏\n" +
                "0.5分：需阴凉或避光/遮光贮藏\n" +
                "注意：当说明书中【贮藏】中明确提及“阴凉”、“20℃以下”、“遮光”、“避光”等时，直接给0.5分,反之，需要给1分。\n只返回一个数字，不要其他的内容";

        String gpt = "";
        if (isNew){
            gpt = lxGptService.getGpt(storagePrompt, "qwen3-235b-a22b-instruct-2507", "1,0.5");
        }else {
            gpt = lxGptService.getGpt(storagePrompt, "", "1,0.5");
        }


        trTechnologyEvaluationDto.setStorageScore(extractLastNumber(gpt));
        trTechnologyEvaluationDto.setStorageContent(drugInfoNew.getStorage());

        write("storageScore", trTechnologyEvaluationDto.getStorageScore(), response, cacheDtos, "存储得分");
        write("storageContent", trTechnologyEvaluationDto.getStorageContent(), response, cacheDtos, "存储内容");


        // 有效期
        String validityPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getIndate() + "*****，" +
                "请帮我打分，药品有效期大于24个月1分，小于24个月0分，只返回一个数字";

        String gpt1 = "";
        if (isNew){
            gpt1 = lxGptService.getGpt(validityPrompt, "qwen3-235b-a22b-instruct-2507", "1,0");
        }else {
            gpt1 =  lxGptService.getGpt(validityPrompt, "", "1,0");
        }



        trTechnologyEvaluationDto.setValidityPeriodScore(extractLastNumber(gpt1));
        trTechnologyEvaluationDto.setValidityPeriodContent(drugInfoNew.getIndate());

        write("validityPeriodScore", trTechnologyEvaluationDto.getValidityPeriodScore(), response, cacheDtos, "有效期得分");
        write("validityPeriodContent", trTechnologyEvaluationDto.getValidityPeriodContent(), response, cacheDtos, "有效期内容");

        trTechnologyEvaluationDto.setSuitabilityScore();
        write("suitabilityScore", trTechnologyEvaluationDto.getSuitabilityScore(), response, cacheDtos, "适宜性总得分");


        // 保护品种
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

        write("nationalTraditionalChineseMedicineProtectionScore", trTechnologyEvaluationDto.getNationalTraditionalChineseMedicineProtectionScore(), response, cacheDtos, "保护品种得分");
        write("nationalTraditionalChineseMedicineProtectionContent", trTechnologyEvaluationDto.getNationalTraditionalChineseMedicineProtectionContent(), response, cacheDtos, "保护品种内容");


        // 药典
        if (StringUtils.isNotEmpty(drugInfoNew.getIsInclude()) && "收载在《中国药典》中。".equals(drugInfoNew.getIsInclude())) {
            String chineseMedicine = "本品已收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(1.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);

        } else {
            String chineseMedicine = "本品未收录在《中国药典》中。";
            trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(0.0);
            trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
        }
        write("chinesePharmacopoeiaScore", trTechnologyEvaluationDto.getChinesePharmacopoeiaScore(), response, cacheDtos, "药典得分");
        write("chinesePharmacopoeiaContent", trTechnologyEvaluationDto.getChinesePharmacopoeiaContent(), response, cacheDtos, "药典内容");


        // 专利
        // 使用prompt

        Criteria criteria = new Criteria().andOperator(
                Criteria.where("title").regex(".*" + drugInfoNew.getDrugName() + ".*"),
                Criteria.where("patentee").is(drugInfoNew.getManufacturer())
        ).and("applicationTime").exists(true);

        // 创建 Query 对象并添加 Criteria 和排序
        Query query = new Query(criteria);
        query.with(Sort.by(Sort.Direction.DESC, "applicationTime"));
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


        } else {


            String patentsPrompt = "药品" + drugInfoNew.getDrugName() + "中成药是否获得过专利？若有，请提供准确的专利号，若无，请不要提供虚假或者假设信息，直接输出'暂未查询到药品的相关专利信息。'就可以。";

            String gpt2 = "";
            if (isNew){
                 gpt2 = lxGptService.getGpt(patentsPrompt, "qwen3-235b-a22b-instruct-2507", "");
            }else {
                 gpt2 = lxGptService.getGpt(patentsPrompt, "", "");
            }

            if (gpt2.contains("无相关专利") || gpt2.contains("暂未查询到药品的相关专利信息")) {
                trTechnologyEvaluationDto.setPatentScore(0.0);
                trTechnologyEvaluationDto.setPatentNumber("无相关专利");
            } else {
                trTechnologyEvaluationDto.setPatentScore(1.0);
                trTechnologyEvaluationDto.setPatentNumber(gpt2);
            }
        }
        write("patentScore", trTechnologyEvaluationDto.getPatentScore(), response, cacheDtos, "专利相关分数");
        write("patentNumber", trTechnologyEvaluationDto.getPatentNumber(), response, cacheDtos, "专利内容");

        // 是否是独家品种
        List<DrugInfoNew> drugName = mongoTemplate.find(Query.query(Criteria.where("drugName").is(drugInfoNew.getDrugName())), DrugInfoNew.class);
        HashSet<String> strings = new HashSet<>();
        for (DrugInfoNew infoNew : drugName) {
            strings.add(infoNew.getManufacturer());
        }

        HashSet<String> strings1 = new HashSet<String>();
        for (String string : strings) {
            if (string.contains("集团")) {
                String[] split = string.split("集团");
                strings1.add(split[0] + "集团");
            } else {
                strings1.add(string);
            }
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
        write("exclusiveVarietyScore", trTechnologyEvaluationDto.getExclusiveVarietyScore(), response, cacheDtos, "独家品种得分");
        write("exclusiveVarietyInfo", trTechnologyEvaluationDto.getExclusiveVarietyInfo(), response, cacheDtos, "独家品种内容");
        trTechnologyEvaluationDto.setAdditionalZodiacScore();
        write("additionalZodiacScore", trTechnologyEvaluationDto.getAdditionalZodiacScore(), response, cacheDtos, "附加属性总得分");


        trTechnologyEvaluationDto.setTotalScore();
//        write("productionEnterpriseStatusScore", trTechnologyEvaluationDto.getProductionEnterpriseStatusScore(), response);
        write("technologyEvaluationScore", trTechnologyEvaluationDto.getTotalScore(), response, cacheDtos, "技术评价总得分");





        return step;

    }



    public int getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilderx, int step, TrTechnologyEvaluationDto trTechnologyEvaluationDto, HttpServletResponse response, JSONObject jsonObjectMar, List<CacheDto> cacheDtos) {
        // 初始化信号量控制并发
        Semaphore semaphore = new Semaphore(5);

        // 并行处理频次
        CompletableFuture<JSONObject> frequencyFuture = CompletableFuture.supplyAsync(() -> {
            String prompt = "你作为一名专业的中成药执业药师，非常了解中成药相关用法用量，特别是中成药的给药频次。" +
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
                    "（2）当用法用量中没有明确给药次数时，给0分。如：“每日数次。”或者“根据症状适当增减。”\n";

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content", "药品用药频次相关的内容");
            stringStringHashMap.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(prompt, "frequency", GptDemoEnum.GPT_DEMO_1.getContent(), "","2,1.5,1,0");
                }else {
                    return lxGptService.executeGptPlus(prompt, "frequency", responseFormat, "", "2,1.5,1,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理规格包装使用量抽取
        CompletableFuture<JSONObject> packagingFuture = CompletableFuture.supplyAsync(() -> {
            String prompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****&&&【用法用量】：" + drugInfoNew.getUsageAndDosage() + "&&&。【规格】：" + drugInfoNew.getSpecifications() +
                    "。&&&【包装】：" + drugInfoNew.getPack() + "*****，" +
                    "请参照下方我提供的示例，抽取上方所给出资料中对应的内容（无对应内容返回空字段即可），对应字段如下：" +
                    "packagQuantity:包装数值；packagQuantityUnit：包装单位；singleDoseUsage：单次用药量(请抽取临床常用单次剂量，若单次用药剂量为区间范围数值时（如每次1-2片），取数值大的那个（取2）)；singleDoseUsageUnit：单次用药单位（尽量与规格单位统一）" +
                    "medicationFrequency：用药频率；medicationFrequencyUnit：用药频率单位（一般为：次/日，也可为：月/次）；miniQuantity：规格数值（提供的规格中可能存在多种不同的单位，如“每瓶装2g”，这里面既有单位“瓶”，又有单位“g”，在提取规格的数值时，需要根据单次用量的单位进行选取（注意：提取的规格的数值的所属单位必须与单次用量的单位相同才行）" +
                    "\nminiQuantityUnit:规格单位（尽量与单次用量统一）" +
                    "【用法用量】含服。⼀次4-6丸，⼀⽇ 3次；急性发作时，⼀次10-15丸。【包装】瓷瓶装，50 丸× 3 瓶。【规格】每丸重 40 mg。" +
                    "请返回以下内容：" +
                    "    \"packagQuantity\":150,\n" +
                    "    \"packagQuantityUnit\":\"丸\",\n" +
                    "    \"singleDoseUsage\":6,\n" +
                    "    \"singleDoseUsageUnit\":\"丸\",\n" +
                    "    \"medicationFrequency\":3,\n" +
                    "    \"medicationFrequencyUnit\":\"次/日\",\n" +
                    "    \"miniQuantity\":\"1\"\n" +
                    "    \"miniQuantityUnit\":\"丸\"\n" +
                    "\n" +
                    "}   注意：以下内容只针对miniQuantity字段：根据我提供的药品说明书中的【规格】以及【用法用量】原文，将药品规格信息提取出来。提取规则最好是规格与单次用量单位相同，若未提供单次用量，请按照你自己的理解进行提取。\n" +
                    "以下是我提供给你的几个示例，你可以按照我提供的示例结果相关思路来处理。\n" +
                    "\n" +
                    "示例1：\n" +
                    "【规格】(1)5×7cm (2)7×10cm\n" +
                    "【用法用量】无\n" +
                    "需要提取的规格结果为：1贴（只有贴剂规格才是cm×cm，显示的是膏药的大小）\n" +
                    "\n" +
                    "示例2：\n" +
                    "【规格】每丸重60mg(相当于银杏叶提取物16mg)\n" +
                    "【用法用量】口服。一次5丸，一日3次，或遵医嘱。\n" +
                    "需要提取的规格结果为：1丸\n" +
                    "\n" +
                    "示例3：\n" +
                    "【规格】每袋(瓶)装2g \n" +
                    "【用法用量】口服。一次2g，一日2次。\n" +
                    "需要提取的规格结果为：2g\n" +
                    "\n" +
                    "示例4：\n" +
                    "【规格】每1ml相当于饮片2.14g\n" +
                    "【用法用量】口服。一次20ml,一日3次\n" +
                    "需要提取的规格结果为：1ml\n" +
                    "\n" +
                    "示例5：\n" +
                    "【规格】每瓶装250ml\n" +
                    "【用法用量】口服,一次10毫升,一日3次。\n" +
                    "需要提取的规格结果为：250ml";

            HashMap<String, String> stringStringHashMapx = new HashMap<>();
            stringStringHashMapx.put("packagQuantity", "包装规格");
            stringStringHashMapx.put("packagQuantityUnit", "包装规格单位");
            stringStringHashMapx.put("singleDoseUsage", "单次剂量");
            stringStringHashMapx.put("singleDoseUsageUnit", "单次剂量单位");
            stringStringHashMapx.put("medicationFrequency", "用药频率");
            stringStringHashMapx.put("medicationFrequencyUnit", "用药频率单位");
            stringStringHashMapx.put("miniQuantity", "包装");
            stringStringHashMapx.put("miniQuantityUnit", "包装单位");
            JSONObject responseFormatx = getResponseFormat(stringStringHashMapx);
            try {
                semaphore.acquire();
                return lxGptService.executeGptPlus(prompt, "prompt", responseFormatx, "", "");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理疗程
        CompletableFuture<JSONObject> courseFuture = CompletableFuture.supplyAsync(() -> {
            String coursePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.toString() + "*****，" +
                    "1.首先，根据我提供的内容，先判断是否有“疗程”相关原文内容，若有，请帮我挑选出药品疗程相关的内容；若没有相关的则返回暂无疗程相关内容 +\n" +
                    "2.结合以下评分规则，给出药品使用疗程的最终得分：（单选）\n" +
                    "疗程有明确限定：1分；\n" +
                    "未提及疗程：0分。\n";
            HashMap<String, String> stringStringHashMap1 = new HashMap<>();
            stringStringHashMap1.put("content", "药品疗程相关的内容");
            stringStringHashMap1.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat1 = getResponseFormat(stringStringHashMap1);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(coursePrompt, "course", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
                }else {
                    return lxGptService.executeGptPlus(coursePrompt, "course", responseFormat1, "", "1,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理存储
        CompletableFuture<String> storageFuture = CompletableFuture.supplyAsync(() -> {
            String storagePrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getStorage() + "*****，" +
                    "作为一名专业的药师，请根据说明书原文内容，结合以下打分规则进行评分。\n" +
                    "1分：常温贮藏\n" +
                    "0.5分：需阴凉或避光/遮光贮藏\n" +
                    "注意：当说明书中【贮藏】中明确提及“阴凉”、“20℃以下”、“遮光”、“避光”等时，直接给0.5分,反之，需要给1分。\n只返回一个数字，不要其他的内容";
            try {
                semaphore.acquire();
                if (isNew){
                    return lxGptService.getGpt(storagePrompt, "qwen3-235b-a22b-instruct-2507", "1,0.5");
                }else {
                    return lxGptService.getGpt(storagePrompt, "", "1,0.5");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "1";
            } finally {
                semaphore.release();
            }
        });

        // 并行处理有效期
        CompletableFuture<String> validityFuture = CompletableFuture.supplyAsync(() -> {
            String validityPrompt = "药品" + drugInfoNew.getDrugName() + "说明书如下*****" + drugInfoNew.getIndate() + "*****，" +
                    "请帮我打分，药品有效期大于24个月1分，小于24个月0分，只返回一个数字";
            try {
                semaphore.acquire();
                if (isNew){
                    return lxGptService.getGpt(validityPrompt, "qwen3-235b-a22b-instruct-2507", "1,0");
                }else {
                    return lxGptService.getGpt(validityPrompt, "", "1,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "0";
            } finally {
                semaphore.release();
            }
        });

        // 并行处理专利
        CompletableFuture<List<Patent>> patentsFuture = CompletableFuture.supplyAsync(() -> {
            Criteria criteria = new Criteria().andOperator(
                    Criteria.where("title").regex(".*" + drugInfoNew.getDrugName() + ".*"),
                    Criteria.where("patentee").is(drugInfoNew.getManufacturer())
            ).and("applicationTime").exists(true);

            // 创建 Query 对象并添加 Criteria 和排序
            Query query = new Query(criteria);
            query.with(Sort.by(Sort.Direction.DESC, "applicationTime"));
            return mongoTemplate.find(query, Patent.class);
        });

        // 并行处理专利查询（当数据库没有专利时）
        CompletableFuture<String> patentQueryFuture = CompletableFuture.supplyAsync(() -> {
            String patentsPrompt = "药品" + drugInfoNew.getDrugName() + "中成药是否获得过专利？若有，请提供准确的专利号，若无，请不要提供虚假或者假设信息，直接输出'暂未查询到药品的相关专利信息。'就可以。";
            try {
                semaphore.acquire();
                if (isNew){
                    return lxGptService.getGpt(patentsPrompt, "qwen3-235b-a22b-instruct-2507", "");
                }else {
                    return lxGptService.getGpt(patentsPrompt, "", "");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "暂未查询到药品的相关专利信息。";
            } finally {
                semaphore.release();
            }
        });

        // 并行处理独家品种查询
        CompletableFuture<List<DrugInfoNew>> exclusiveVarietyFuture = CompletableFuture.supplyAsync(() ->
                mongoTemplate.find(Query.query(Criteria.where("drugName").is(drugInfoNew.getDrugName())), DrugInfoNew.class));

        // 等待所有并行任务完成并处理结果
        try {
            // 处理频次结果
            JSONObject jsonObject = frequencyFuture.get();
            trTechnologyEvaluationDto.setAdministrationFrequencyScore(extractLastNumber(jsonObject.getString("score")));
            trTechnologyEvaluationDto.setAdministrationFrequencyContent(jsonObject.getString("content"));
            write("administrationFrequencyScore", trTechnologyEvaluationDto.getAdministrationFrequencyScore(), response, cacheDtos, "频次得分");
            write("administrationFrequencyContent", trTechnologyEvaluationDto.getAdministrationFrequencyContent(), response, cacheDtos, "频次");

            // 处理规格包装使用量抽取结果
            JSONObject prompt1 = packagingFuture.get();
            // 包装规格
            String packagQuantity = prompt1.getString("packagQuantity") + prompt1.getString("packagQuantityUnit");
            // 单次用药计量
            String singleDose = prompt1.getString("singleDoseUsage") + prompt1.getString("singleDoseUsageUnit");
            // 频率
            String medicationFrequency = prompt1.getString("medicationFrequency") + prompt1.getString("medicationFrequencyUnit");

            String minPackag = drugInfoNew.getNumber();
            if (StringUtils.isEmpty(minPackag)) {
                minPackag = prompt1.getString("miniQuantity") + prompt1.getString("miniQuantityUnit");
            }

            // 包装规格计算
            double packagingSpecification = getPackagingSpecification(packagQuantity, singleDose, medicationFrequency, drugInfoNew.getPack(), drugInfoNew.getUsageAndDosage());
            if (packagingSpecification != 0) {
                boolean doubleInteger = isDoubleInteger(packagingSpecification);
                if (doubleInteger) {
                    write("packagingSpecificationScore", 1, response, cacheDtos, "包装规格得分");
                    trTechnologyEvaluationDto.setPackagingSpecificationScore(1.00);
                    write("packagingSpecificationOption", "1", response, cacheDtos, "包装规格选项");
                } else {
                    write("packagingSpecificationScore", 0.5, response, cacheDtos, "包装规格得分");
                    trTechnologyEvaluationDto.setPackagingSpecificationScore(0.50);
                    write("packagingSpecificationOption", "2", response, cacheDtos, "包装规格选项");
                }
            } else {
                write("packagingSpecificationScore", 0, response, cacheDtos, "包装规格得分");
                write("packagingSpecificationOption", "", response, cacheDtos, "包装规格选项");
            }

            JSONObject jsonObject4 = new JSONObject();
            jsonObject4.put("packagQuantity", packagQuantity);
            jsonObject4.put("singleDose", singleDose);
            jsonObject4.put("medicationFrequency", medicationFrequency);
            // 用法用量
            jsonObject4.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
            // 包装
            jsonObject4.put("pack", drugInfoNew.getPack());

            jsonObjectMar.put("singleDose", singleDose);
            jsonObjectMar.put("medicationFrequency", medicationFrequency);
            jsonObjectMar.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
            jsonObjectMar.put("price", "");

            write("packagingSpecificationJson", jsonObject4, response, cacheDtos, "包装规格信息");

            // 大包装
            trTechnologyEvaluationDto.setLargePackageAdoptionScore(0.0);
            write("largePackageAdoptionScore", trTechnologyEvaluationDto.getLargePackageAdoptionScore(), response, cacheDtos, "采用大包装得分");
            write("largePackageAdoptionOption", "", response, cacheDtos, "采用大包装选项");
            JSONObject jsonObject5 = new JSONObject();
            jsonObject5.put("packagQuantity", packagQuantity);
            jsonObject5.put("singleDose", singleDose);
            // 用法用量
            jsonObject5.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
            // 包装
            jsonObject5.put("pack", drugInfoNew.getPack());
            write("largePackageAdoptionJson", jsonObject5, response, cacheDtos, "采用大包装信息");

            // 单剂量
            double singleDose1 = getSingleDose(minPackag, singleDose, drugInfoNew.getUsageAndDosage(), drugInfoNew.getSpecifications());
            if (singleDose1 != 0.0) {
                if (singleDose1 == 1) {
                    trTechnologyEvaluationDto.setSingleDoseScore(1.00);
                    trTechnologyEvaluationDto.setSingleDoseOption("1");
                } else if (singleDose1 > 1) {
                    trTechnologyEvaluationDto.setSingleDoseScore(0.8);
                    trTechnologyEvaluationDto.setSingleDoseOption("2");
                } else if (singleDose1 < 1) {
                    trTechnologyEvaluationDto.setSingleDoseScore(0.5);
                    trTechnologyEvaluationDto.setSingleDoseOption("3");
                }
            } else {
                trTechnologyEvaluationDto.setSingleDoseScore(1.00);
                trTechnologyEvaluationDto.setSingleDoseOption("");
            }
            write("singleDoseScore", trTechnologyEvaluationDto.getSingleDoseScore(), response, cacheDtos, "临床常用单次用量与药品规格的适配性得分");
            write("singleDoseOption", trTechnologyEvaluationDto.getSingleDoseOption(), response, cacheDtos, "临床常用单次用量与药品规格适配选项");

            JSONObject jsonObject6 = new JSONObject();
            // 规格
            jsonObject6.put("miniQuantity", minPackag);
            jsonObject6.put("singleDose", singleDose);
            // 用法用量
            jsonObject6.put("usageAndDosage", drugInfoNew.getUsageAndDosage());
            // 包装
            jsonObject6.put("specifications", drugInfoNew.getSpecifications());
            write("singleDoseJson", jsonObject6, response, cacheDtos, "临床常用单次用量与药品规格信息");

            // 处理疗程结果
            JSONObject jsonObject1 = courseFuture.get();
            trTechnologyEvaluationDto.setCourseOfTreatmentScore(extractLastNumber(jsonObject1.getString("score")));
            trTechnologyEvaluationDto.setCourseOfTreatmentContent(jsonObject1.getString("content"));
            write("courseOfTreatmentScore", trTechnologyEvaluationDto.getCourseOfTreatmentScore(), response, cacheDtos, "疗程得分");
            write("courseOfTreatmentContent", trTechnologyEvaluationDto.getCourseOfTreatmentContent(), response, cacheDtos, "疗程内容");

            // 处理存储结果
            String gpt = storageFuture.get();
            trTechnologyEvaluationDto.setStorageScore(extractLastNumber(gpt));
            trTechnologyEvaluationDto.setStorageContent(drugInfoNew.getStorage());
            write("storageScore", trTechnologyEvaluationDto.getStorageScore(), response, cacheDtos, "存储得分");
            write("storageContent", trTechnologyEvaluationDto.getStorageContent(), response, cacheDtos, "存储内容");

            // 处理有效期结果
            String gpt1 = validityFuture.get();
            trTechnologyEvaluationDto.setValidityPeriodScore(extractLastNumber(gpt1));
            trTechnologyEvaluationDto.setValidityPeriodContent(drugInfoNew.getIndate());
            write("validityPeriodScore", trTechnologyEvaluationDto.getValidityPeriodScore(), response, cacheDtos, "有效期得分");
            write("validityPeriodContent", trTechnologyEvaluationDto.getValidityPeriodContent(), response, cacheDtos, "有效期内容");

            trTechnologyEvaluationDto.setSuitabilityScore();
            write("suitabilityScore", trTechnologyEvaluationDto.getSuitabilityScore(), response, cacheDtos, "适宜性总得分");

            // 处理保护品种
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
            write("nationalTraditionalChineseMedicineProtectionScore", trTechnologyEvaluationDto.getNationalTraditionalChineseMedicineProtectionScore(), response, cacheDtos, "保护品种得分");
            write("nationalTraditionalChineseMedicineProtectionContent", trTechnologyEvaluationDto.getNationalTraditionalChineseMedicineProtectionContent(), response, cacheDtos, "保护品种内容");

            // 处理药典
            if (StringUtils.isNotEmpty(drugInfoNew.getIsInclude()) && "收载在《中国药典》中。".equals(drugInfoNew.getIsInclude())) {
                String chineseMedicine = "本品已收录在《中国药典》中。";
                trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(1.0);
                trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
            } else {
                String chineseMedicine = "本品未收录在《中国药典》中。";
                trTechnologyEvaluationDto.setChinesePharmacopoeiaScore(0.0);
                trTechnologyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
            }
            write("chinesePharmacopoeiaScore", trTechnologyEvaluationDto.getChinesePharmacopoeiaScore(), response, cacheDtos, "药典得分");
            write("chinesePharmacopoeiaContent", trTechnologyEvaluationDto.getChinesePharmacopoeiaContent(), response, cacheDtos, "药典内容");

            // 处理专利结果
            List<Patent> patents = patentsFuture.get();
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
            } else {
                String gpt2 = patentQueryFuture.get();
                if (gpt2.contains("无相关专利") || gpt2.contains("暂未查询到药品的相关专利信息")) {
                    trTechnologyEvaluationDto.setPatentScore(0.0);
                    trTechnologyEvaluationDto.setPatentNumber("无相关专利");
                } else {
                    trTechnologyEvaluationDto.setPatentScore(1.0);
                    trTechnologyEvaluationDto.setPatentNumber(gpt2);
                }
            }
            write("patentScore", trTechnologyEvaluationDto.getPatentScore(), response, cacheDtos, "专利相关分数");
            write("patentNumber", trTechnologyEvaluationDto.getPatentNumber(), response, cacheDtos, "专利内容");

            // 处理独家品种结果
            List<DrugInfoNew> drugName = exclusiveVarietyFuture.get();
            HashSet<String> strings = new HashSet<>();
            for (DrugInfoNew infoNew : drugName) {
                strings.add(infoNew.getManufacturer());
            }

            HashSet<String> strings1 = new HashSet<String>();
            for (String string : strings) {
                if (string.contains("集团")) {
                    String[] split = string.split("集团");
                    strings1.add(split[0] + "集团");
                } else {
                    strings1.add(string);
                }
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
            write("exclusiveVarietyScore", trTechnologyEvaluationDto.getExclusiveVarietyScore(), response, cacheDtos, "独家品种得分");
            write("exclusiveVarietyInfo", trTechnologyEvaluationDto.getExclusiveVarietyInfo(), response, cacheDtos, "独家品种内容");

            trTechnologyEvaluationDto.setAdditionalZodiacScore();
            write("additionalZodiacScore", trTechnologyEvaluationDto.getAdditionalZodiacScore(), response, cacheDtos, "附加属性总得分");

            trTechnologyEvaluationDto.setTotalScore();
            write("technologyEvaluationScore", trTechnologyEvaluationDto.getTotalScore(), response, cacheDtos, "技术评价总得分");

        } catch (Exception e) {
            log.error("Error processing technology evaluation", e);
        }

        return step;
    }





    
   
    // 日均治疗费用  参数单次用量、使用频率、单价
    public double getDailyTreatmentCost(String singleDose, String medicationFrequency, String price) {
        String prompt = "根据我给出的***单次用量：" + singleDose + "***使用频率：" + medicationFrequency + "***单价：" + price + "完成下列计算：计算公式=单次用量*使用频率*单价；；；在此过程中或许要参考" +
                "最后返回一个doble类型的值（保留两位小数），如果信息不全则返回0.0";
        String gpt = "";
        if (isNew){
         gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "");
        }else {
           gpt = lxGptService.getGpt(prompt, "gpt-5-mini", "");
       }

        if (StringUtils.isNotEmpty(gpt)) {
            return extractLastNumber(gpt);
        }
        return 0.0;
    }


    public boolean isDoubleInteger(double value) {
        // 判断是否为整数：若与强制类型转换后的 int 值相等，则说明是整数
        return value == (int) value;
    }

    // 市场评价
    public int getTrMarketEvaluationDto_bak(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrMarketEvaluationDto trMarketEvaluationDto, HttpServletResponse response, JSONObject jsonObjectMar, List<CacheDto> cacheDtos) {
        // 市场独特性
        // todo  先直接赋值
//
//        trMarketEvaluationDto.setMarketUniquenessScore(0.0);
//        trMarketEvaluationDto.setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");
        write("marketUniquenessScore", trMarketEvaluationDto.getMarketUniquenessScore(), response, cacheDtos, "市场独特性得分");
        write("marketUniquenessOption", "", response, cacheDtos, "市场独特性选项");
        write("marketUniquenessContent", "", response, cacheDtos, "市场独特性描述");

//        //经济性
//        trMarketEvaluationDto.setEconomicScore(0.0);
//        trMarketEvaluationDto.setEconomicOption("日均治疗费用较同类中成药价格较低，且具有明显的药物经济学优势");


        write("dailyTreatmentCostJson", jsonObjectMar, response, cacheDtos, "日均治疗费用信息");
        write("dailyTreatmentCostScore", trMarketEvaluationDto.getDailyTreatmentCostScore(), response, cacheDtos, "日均治疗费用得分");
        write("dailyTreatmentCostOption", "", response, cacheDtos, "日均治疗费用选项");


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
        StringBuilder stringBuilder4 = new StringBuilder();
        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
            stringBuilder4.append("*******文献id：" + literatureSearchHit.getContent().getId());
            stringBuilder4.append("文献标题：" + literatureSearchHit.getContent().getTitle());
            stringBuilder4.append("文献摘要：" + literatureSearchHit.getContent().getSummary() + "*********");
        }


        if (stringBuilder4.length() > 0) {
            String gptTxt = "你作为一名药物经济学专家，擅长分析经济学相关文献。请帮我分析一下我提供的文献是否属于经济学文献，请将你认为是与" + drugInfoNew.getDrugName() +
                    "有关的经济学文献的“id”中的内容全部返回给我，多个id用','隔开，如：'id1,id2,id3'。\n" +
                    "经济学文献的特征包括但不限于以下情况：\n" +
                    "标题中带有“药物经济学”、“成本-效果”、“成本-效用”、“成本-效益”、“cost”、“预算”等关键词；" +
                    "文献内容：" + stringBuilder4;

            String gptx = "";
            if(isNew){
                gptx = lxGptService.getGpt(gptTxt, "qwen3-235b-a22b-instruct-2507", "");
            }else {
                gptx = lxGptService.getGpt(gptTxt, "gpt-4.1-nano-2025-04-14", "");
            }





            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                if (gptx.contains(literatureSearchHit.getContent().getId())) {
                    JSONObject jsonObject1 = new JSONObject();
                    jsonObject1.put("title", HtmlUtil.cleanHtmlTag(literatureSearchHit.getContent().getTitle()));
                    stringBuilder3.append("标题：" + literatureSearchHit.getContent().getTitle());
                    jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                    stringBuilder3.append("摘要：" + literatureSearchHit.getContent().getSummary());
                    jsonObjects.add(jsonObject1);
                }
            }


            if (jsonObjects.size() == 0) {
                trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber("0"));
            }

            String prompt = "你作为一名中药物经济学专家，请根据我提供的经济学相关文献的题目+摘要信息，判断一下" + drugInfoNew.getDrugName() + "与其他药物相比，" + drugInfoNew.getDrugName() +
                    "是否具有经济学优势（若未提供文献，则代表无经济学优势）：\n" +
                    "并根据以下评分规则进行评分（单选）" +
                    "2分：有经济学优势；" +
                    "0分：无经济学优势；\n" +
                    "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
                    "经济学文献：\n" +
                    stringBuilder3.toString();

            String gpt = "";
            if (isNew){
                gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "2,0");
            }else {
                gpt = lxGptService.getGpt(prompt, "", "2,0");
            }

            trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber(gpt));

        } else {
            trMarketEvaluationDto.setEconomicAdvantageScore(0.0);
        }

        write("economicAdvantageScore", trMarketEvaluationDto.getEconomicAdvantageScore(), response, cacheDtos, "经济学优势得分");
        write("economicAdvantageOption", jsonObjects, response, cacheDtos, "经济学优势内容");


        trMarketEvaluationDto.setEconomicScore();


        write("economicScore", trMarketEvaluationDto.getEconomicScore(), response, cacheDtos, "经济性总得分");
//        write("economicOption","", response);


        // 国家基本药物
        String essentialMedicines = drugInfoNew.getEssentialMedicines();
        if (StringUtils.isNotEmpty(essentialMedicines) && "是".equals(essentialMedicines)) {
            trMarketEvaluationDto.setNationalEssentialDrugsScore(3.0);
            trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品被《国家基本药物目录》收载");
        } else {
            trMarketEvaluationDto.setNationalEssentialDrugsScore(0.0);
            trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品未被《国家基本药物目录》收载");
        }

        write("nationalEssentialDrugsRequirement", trMarketEvaluationDto.getNationalEssentialDrugsRequirement(), response, cacheDtos, "国家基本药物");
        write("nationalEssentialDrugsScore", trMarketEvaluationDto.getNationalEssentialDrugsScore(), response, cacheDtos, "国家基本药物得分");

        // 医保
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

        write("nationalMedicalInsuranceDrugsPaymentRequirement", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsPaymentRequirement(), response, cacheDtos, "医保内容");
        write("nationalMedicalInsuranceDrugsScore", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsScore(), response, cacheDtos, "医保得分");

        // 集采

        //是否得分
        boolean isConcentrate = true;
        String drugCollection = drugInfoNew.getDrugCollection();
        String isTheAgreementForTheJudgment = drugInfoNew.getIsTheAgreementForTheJudgment();
        String termOfAgreement = drugInfoNew.getTermOfAgreement();
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
        write("centralizedVolumePurchasingDrugsScore", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsScore(), response, cacheDtos, "国家集采");
        write("centralizedVolumePurchasingDrugsSource", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsSource(), response, cacheDtos, "国家集采内容");

        // 生产企业情况
        // prompt判断
        String productionEnterpriseStatusPrompt = "**任务：** 根据提供的企业排名数据，对指定药品的生产企业进行评分。\n" +
                "**输入信息：**\n" +
                "1.  **药品名称：** `{"+drugInfoNew.getDrugName()+"}`\n" +
                "2.  **生产企业名称：** `{"+drugInfoNew.getManufacturer()+"}`\n" +
                "**评分规则（单选，最高3分）：**\n" +
                "请根据以下层级判断生产企业所属类别，并赋予相应分数：\n" +
                "1.  **3分：** 该生产企业或其所属集团出现在以下任一榜单：\n" +
                "    *   **工信部“2023年度中国医药工业百强企业”**\n" +
                "    *   **“2024年中药老字号品牌TOP50”**\n" +
                "2.  **2分：** 该生产企业或其所属集团出现在 **“2023年度中国中药企业TOP100排行榜”**。\n" +
                "3.  **1分：** 该生产企业不属于以上任何榜单（即“其他企业”）。\n" +
                "**关键注意事项：**\n" +
                "1.  **名称模糊匹配：** 判断时**不要求**输入的生产企业名称 `{drugInfoNew.getManufacturer()}` 与榜单中的企业名称**完全一致**。请根据常识和上下文**判断隶属关系**。\n" +
                "    *   **示例：** “太极集团重庆涪陵制药厂有限公司” **隶属于** “太极集团有限公司”。如果榜单中出现的是“太极集团有限公司”或“太极集团”，则应认为该生产企业满足条件（例如，若“太极集团”在中药TOP100中，则给2分）。\n" +
                "2.  **层级优先：** 规则1（3分）优先级最高，其次是规则2（2分），最后是规则3（1分）。一个企业可能出现在多个榜单，只需满足最高分条件即可（例如，同时出现在百强榜和中药TOP100，给3分）。\n" +
                "3.  **数据依赖：** 你的判断**必须且只能**基于我接下来提供的企业排名数据（包含上述三个榜单）进行。请等待我提供数据。"+
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
                "50\t群星\t广州白云山星群(药业)股份有限公司"
                ;

        String productionEnterpriseStatusPromptx = "药品" + drugInfoNew.getDrugName() + "企业为*****" + drugInfoNew.getManufacturer() + "*****，" +
                "药品成分为：" + drugInfoNew.getIngredient() + "，" +
                "请判断： 该生产企业是否拥有独立的GAP种植基地？若有，请给出种植基地种植的药物是什么？再请判断下这个GAP种植基地中种植的药物是否属于药品成份中的一个？" +
                "打分：有种植基地且属于成分，则返回1分，否则返回0分";

        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("content", "相关内容");
        stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
        JSONObject jsonObject2 = new JSONObject();
        if (isNew){
            jsonObject2 = gptAiUtils.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", GptDemoEnum.GPT_DEMO_1.getContent(), "", "3,2,1");
        }else {
             jsonObject2 = lxGptService.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", responseFormat2, "", "3,2,1");
        }



        if (StringUtils.isNotEmpty(drugInfoUtil.qiyeScore(drugInfoNew.getManufacturer()))){
            jsonObject2.put("score", drugInfoUtil.qiyeScore(drugInfoNew.getManufacturer()));
        }


        JSONObject jsonObject3 = new JSONObject();
        if (isNew){
             jsonObject3 =  gptAiUtils.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
        }else {
             jsonObject3 = lxGptService.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", responseFormat2, "", "1,0");


        }



        write("productionEnterpriseScore", extractLastNumber(jsonObject2.getString("score")), response, cacheDtos, "企业排名得分");
        write("productionEnterpriseContent", jsonObject2.getString("content"), response, cacheDtos, "企业排名内容");


        write("ownPlantingBaseScore", extractLastNumber(jsonObject3.getString("score")), response, cacheDtos, "是否有独立的培植基地得分");
        write("ownPlantingBaseOption", jsonObject3.getString("content"), response, cacheDtos, "是否有独立的培植基地内容");

        write("productionEnterpriseStatusScore", Double.parseDouble(jsonObject2.getString("score")) + Double.parseDouble(jsonObject3.getString("score")), response, cacheDtos, "企业状况得分");
        trMarketEvaluationDto.setPolicyAttributeScore();

        write("policyAttributeScore", trMarketEvaluationDto.getPolicyAttributeScore(), response, cacheDtos, "政策属性总得分");
        trMarketEvaluationDto.setTotalScore();
        write("marketEvaluationTotalScore", trMarketEvaluationDto.getTotalScore() + Double.parseDouble(jsonObject2.getString("score")) + Double.parseDouble(jsonObject3.getString("score")), response, cacheDtos, "市场评价总得分");



        return step;


    }



    public int getTrMarketEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int step, TrMarketEvaluationDto trMarketEvaluationDto, HttpServletResponse response, JSONObject jsonObjectMar, List<CacheDto> cacheDtos) {
        // 初始化信号量控制并发
        Semaphore semaphore = new Semaphore(5);

        // 并行处理市场独特性（目前是占位符）
        CompletableFuture<Void> marketUniquenessFuture = CompletableFuture.runAsync(() -> {
            // 市场独特性
            // todo  先直接赋值
            write("marketUniquenessScore", trMarketEvaluationDto.getMarketUniquenessScore(), response, cacheDtos, "市场独特性得分");
            write("marketUniquenessOption", "", response, cacheDtos, "市场独特性选项");
            write("marketUniquenessContent", "", response, cacheDtos, "市场独特性描述");
        });

        // 并行处理经济性相关文献检索
        CompletableFuture<SearchHits<Literature>> literatureSearchHitsFuture = CompletableFuture.supplyAsync(() -> {
            ArrayList<String> drugZhs = new ArrayList<>();
            drugZhs.add(drugInfoNew.getDrugName());
            StringBuilder stringBuilderx = new StringBuilder();
            StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilderx, drugZhs, "标题,摘要");
            TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 12);

            JSONObject jsonObject = new JSONObject();
            jsonObject.put("query", stringBuilder1.toString());
            jsonObject.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObject);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);

            BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
            boolQueryBuilder.must().add(wrapperQueryBuilder);
            boolQueryBuilder.must().add(termQueryBuilder);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            return this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        });

        // 并行处理国家基本药物判断
        CompletableFuture<Void> essentialDrugsFuture = CompletableFuture.runAsync(() -> {
            // 国家基本药物
            String essentialMedicines = drugInfoNew.getEssentialMedicines();
            if (StringUtils.isNotEmpty(essentialMedicines) && "是".equals(essentialMedicines)) {
                trMarketEvaluationDto.setNationalEssentialDrugsScore(3.0);
                trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品被《国家基本药物目录》收载");
            } else {
                trMarketEvaluationDto.setNationalEssentialDrugsScore(0.0);
                trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品未被《国家基本药物目录》收载");
            }
        });

        // 并行处理医保判断
        CompletableFuture<Void> medicalInsuranceFuture = CompletableFuture.runAsync(() -> {
            // 医保
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
        });

        // 并行处理集采判断
        CompletableFuture<Void> centralizedProcurementFuture = CompletableFuture.runAsync(() -> {
            // 集采
            //是否得分
            boolean isConcentrate = true;
            String drugCollection = drugInfoNew.getDrugCollection();
            String isTheAgreementForTheJudgment = drugInfoNew.getIsTheAgreementForTheJudgment();
            String termOfAgreement = drugInfoNew.getTermOfAgreement();
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
        });

        // 并行处理生产企业情况评分
        CompletableFuture<JSONObject> productionEnterpriseStatusFuture = CompletableFuture.supplyAsync(() -> {
            // 生产企业情况
            // prompt判断
            String productionEnterpriseStatusPrompt = "**任务：** 根据提供的企业排名数据，对指定药品的生产企业进行评分。\n" +
                    "**输入信息：**\n" +
                    "1.  **药品名称：** `{"+drugInfoNew.getDrugName()+"}`\n" +
                    "2.  **生产企业名称：** `{"+drugInfoNew.getManufacturer()+"}`\n" +
                    "**评分规则（单选，最高3分）：**\n" +
                    "请根据以下层级判断生产企业所属类别，并赋予相应分数：\n" +
                    "1.  **3分：** 该生产企业或其所属集团出现在以下任一榜单：\n" +
                    "    *   **工信部“2023年度中国医药工业百强企业”**\n" +
                    "    *   **“2024年中药老字号品牌TOP50”**\n" +
                    "2.  **2分：** 该生产企业或其所属集团出现在 **“2023年度中国中药企业TOP100排行榜”**。\n" +
                    "3.  **1分：** 该生产企业不属于以上任何榜单（即“其他企业”）。\n" +
                    "**关键注意事项：**\n" +
                    "1.  **名称模糊匹配：** 判断时**不要求**输入的生产企业名称 `{drugInfoNew.getManufacturer()}` 与榜单中的企业名称**完全一致**。请根据常识和上下文**判断隶属关系**。\n" +
                    "    *   **示例：** “太极集团重庆涪陵制药厂有限公司” **隶属于** “太极集团有限公司”。如果榜单中出现的是“太极集团有限公司”或“太极集团”，则应认为该生产企业满足条件（例如，若“太极集团”在中药TOP100中，则给2分）。\n" +
                    "2.  **层级优先：** 规则1（3分）优先级最高，其次是规则2（2分），最后是规则3（1分）。一个企业可能出现在多个榜单，只需满足最高分条件即可（例如，同时出现在百强榜和中药TOP100，给3分）。\n" +
                    "3.  **数据依赖：** 你的判断**必须且只能**基于我接下来提供的企业排名数据（包含上述三个榜单）进行。请等待我提供数据。"+
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
                    "50\t群星\t广州白云山星群(药业)股份有限公司"
                    ;

            HashMap<String, String> stringStringHashMap2 = new HashMap<>();
            stringStringHashMap2.put("content", "相关内容");
            stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", GptDemoEnum.GPT_DEMO_1.getContent(), "", "3,2,1");
                }else {
                    return lxGptService.executeGptPlus(productionEnterpriseStatusPrompt, "productionEnterpriseStatus", responseFormat2, "", "3,2,1");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 并行处理生产企业GAP种植基地判断
        CompletableFuture<JSONObject> gapPlantingBaseFuture = CompletableFuture.supplyAsync(() -> {
            String productionEnterpriseStatusPromptx = "药品" + drugInfoNew.getDrugName() + "企业为*****" + drugInfoNew.getManufacturer() + "*****，" +
                    "药品成分为：" + drugInfoNew.getIngredient() + "，" +
                    "请判断： 该生产企业是否拥有独立的GAP种植基地？若有，请给出种植基地种植的药物是什么？再请判断下这个GAP种植基地中种植的药物是否属于药品成份中的一个？" +
                    "打分：有种植基地且属于成分，则返回1分，否则返回0分";

            HashMap<String, String> stringStringHashMap2 = new HashMap<>();
            stringStringHashMap2.put("content", "相关内容");
            stringStringHashMap2.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
            try {
                semaphore.acquire();
                if (isNew){
                    return gptAiUtils.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", GptDemoEnum.GPT_DEMO_1.getContent(), "", "1,0");
                }else {
                    return lxGptService.executeGptPlus(productionEnterpriseStatusPromptx, "productionEnterpriseStatus", responseFormat2, "", "1,0");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new JSONObject();
            } finally {
                semaphore.release();
            }
        });

        // 等待所有并行任务完成并处理结果
        try {
            // 等待市场独特性任务完成
            marketUniquenessFuture.get();

            // 处理经济性相关文献检索结果
            SearchHits<Literature> literatureSearchHits = literatureSearchHitsFuture.get();
            ArrayList<JSONObject> jsonObjects = new ArrayList<>();
            StringBuilder stringBuilder3 = new StringBuilder();
            StringBuilder stringBuilder4 = new StringBuilder();
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                stringBuilder4.append("*******文献id：" + literatureSearchHit.getContent().getId());
                stringBuilder4.append("文献标题：" + literatureSearchHit.getContent().getTitle());
                stringBuilder4.append("文献摘要：" + literatureSearchHit.getContent().getSummary() + "*********");
            }

            if (stringBuilder4.length() > 0) {
                String gptTxt = "你作为一名药物经济学专家，擅长分析经济学相关文献。请帮我分析一下我提供的文献是否属于经济学文献，请将你认为是与" + drugInfoNew.getDrugName() +
                        "有关的经济学文献的“id”中的内容全部返回给我，多个id用','隔开，如：'id1,id2,id3'。\n" +
                        "经济学文献的特征包括但不限于以下情况：\n" +
                        "标题中带有“药物经济学”、“成本-效果”、“成本-效用”、“成本-效益”、“cost”、“预算”等关键词；" +
                        "文献内容：" + stringBuilder4;

                String gptx = "";
                if(isNew){
                    gptx = lxGptService.getGpt(gptTxt, "qwen3-235b-a22b-instruct-2507", "");
                }else {
                    gptx = lxGptService.getGpt(gptTxt, "gpt-4.1-nano-2025-04-14", "");
                }

                for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                    if (gptx.contains(literatureSearchHit.getContent().getId())) {
                        JSONObject jsonObject1 = new JSONObject();
                        jsonObject1.put("title", HtmlUtil.cleanHtmlTag(literatureSearchHit.getContent().getTitle()));
                        stringBuilder3.append("标题：" + literatureSearchHit.getContent().getTitle());
                        jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                        stringBuilder3.append("摘要：" + literatureSearchHit.getContent().getSummary());
                        jsonObjects.add(jsonObject1);
                    }
                }

                if (jsonObjects.size() == 0) {
                    trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber("0"));
                }

                String prompt = "你作为一名中药物经济学专家，请根据我提供的经济学相关文献的题目+摘要信息，判断一下" + drugInfoNew.getDrugName() + "与其他药物相比，" + drugInfoNew.getDrugName() +
                        "是否具有经济学优势（若未提供文献，则代表无经济学优势）：\n" +
                        "并根据以下评分规则进行评分（单选）" +
                        "2分：有经济学优势；" +
                        "0分：无经济学优势；\n" +
                        "返回的结果中，只给出分值就好，分值为阿拉伯数字：2或者0。" +
                        "经济学文献：\n" +
                        stringBuilder3.toString();

                String gpt = "";
                if (isNew){
                    gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "2,0");
                }else {
                    gpt = lxGptService.getGpt(prompt, "", "2,0");
                }

                trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber(gpt));

            } else {
                trMarketEvaluationDto.setEconomicAdvantageScore(0.0);
            }

            write("dailyTreatmentCostJson", jsonObjectMar, response, cacheDtos, "日均治疗费用信息");
            write("dailyTreatmentCostScore", trMarketEvaluationDto.getDailyTreatmentCostScore(), response, cacheDtos, "日均治疗费用得分");
            write("dailyTreatmentCostOption", "", response, cacheDtos, "日均治疗费用选项");
            write("economicAdvantageScore", trMarketEvaluationDto.getEconomicAdvantageScore(), response, cacheDtos, "经济学优势得分");
            write("economicAdvantageOption", jsonObjects, response, cacheDtos, "经济学优势内容");

            trMarketEvaluationDto.setEconomicScore();
            write("economicScore", trMarketEvaluationDto.getEconomicScore(), response, cacheDtos, "经济性总得分");

            // 等待国家基本药物判断任务完成
            essentialDrugsFuture.get();
            write("nationalEssentialDrugsRequirement", trMarketEvaluationDto.getNationalEssentialDrugsRequirement(), response, cacheDtos, "国家基本药物");
            write("nationalEssentialDrugsScore", trMarketEvaluationDto.getNationalEssentialDrugsScore(), response, cacheDtos, "国家基本药物得分");

            // 等待医保判断任务完成
            medicalInsuranceFuture.get();
            write("nationalMedicalInsuranceDrugsPaymentRequirement", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsPaymentRequirement(), response, cacheDtos, "医保内容");
            write("nationalMedicalInsuranceDrugsScore", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsScore(), response, cacheDtos, "医保得分");

            // 等待集采判断任务完成
            centralizedProcurementFuture.get();
            write("centralizedVolumePurchasingDrugsScore", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsScore(), response, cacheDtos, "国家集采");
            write("centralizedVolumePurchasingDrugsSource", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsSource(), response, cacheDtos, "国家集采内容");

            // 处理生产企业情况评分结果
            JSONObject jsonObject2 = productionEnterpriseStatusFuture.get();
            if (StringUtils.isNotEmpty(drugInfoUtil.qiyeScore(drugInfoNew.getManufacturer()))){
                jsonObject2.put("score", drugInfoUtil.qiyeScore(drugInfoNew.getManufacturer()));
            }

            // 处理生产企业GAP种植基地判断结果
            JSONObject jsonObject3 = gapPlantingBaseFuture.get();

            write("productionEnterpriseScore", extractLastNumber(jsonObject2.getString("score")), response, cacheDtos, "企业排名得分");
            write("productionEnterpriseContent", jsonObject2.getString("content"), response, cacheDtos, "企业排名内容");

            write("ownPlantingBaseScore", extractLastNumber(jsonObject3.getString("score")), response, cacheDtos, "是否有独立的培植基地得分");
            write("ownPlantingBaseOption", jsonObject3.getString("content"), response, cacheDtos, "是否有独立的培植基地内容");

            write("productionEnterpriseStatusScore", Double.parseDouble(jsonObject2.getString("score")) + Double.parseDouble(jsonObject3.getString("score")), response, cacheDtos, "企业状况得分");
            trMarketEvaluationDto.setPolicyAttributeScore();

            write("policyAttributeScore", trMarketEvaluationDto.getPolicyAttributeScore(), response, cacheDtos, "政策属性总得分");
            trMarketEvaluationDto.setTotalScore();
            write("marketEvaluationTotalScore", trMarketEvaluationDto.getTotalScore() + Double.parseDouble(jsonObject2.getString("score")) + Double.parseDouble(jsonObject3.getString("score")), response, cacheDtos, "市场评价总得分");

        } catch (Exception e) {
            log.error("Error processing market evaluation", e);
        }

        return step;
    }





    public void write(String key, Object value, HttpServletResponse response, List<CacheDto> cacheDtos, String describe) {
        CacheDto cacheDto = new CacheDto(key, value, describe);
        cacheDtos.add(cacheDto);
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
        } catch (Exception e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }


    public String extractContent(String key, Object value) {
        // 将key和value变为json格式的字符串
        if (value == null) {
            value = "";
        }
        if (key.contains("Score")) {
            value = formatScore(value.toString());
        }
        if (key.contains("evidenceRecommendationContent") || key.contains("clinicalResearchContent") || key.contains("safetyReevaluationContent")
                || key.contains("economicAdvantageOption")) {
            return "{\"" + key + "\":" + value + "}";
        }
        if (key.contains("Json")) {
            return "{\"" + key + "\":" + value + "}";
        }


        String jsonString = "{\"" + key + "\":\"" + value.toString().replaceAll("\"", "'") + "\"}";
        return jsonString;
    }


    private String formatScore(String score) {
        //(1) 得分为整数的，直接显示分值，数值后不需要.00。如15;
        //(2) 得分为非整数的，请保留小数点后两位有效数字。
        double number = 0;
        try {
            number = Double.parseDouble(score);
        } catch (NumberFormatException e) {
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
}


