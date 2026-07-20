package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.feign.FormulaFeign;
import com.sentum.pojo.GuideAndScore;

import com.sentum.pojo.dto.GuideScoreTableDto;
import com.sentum.pojo.dto.GuideScoreTableTrDto;
import com.sentum.pojo.vo.GuideVO;
import com.sentum.pojo.vo.TrGuideVo;
import com.sentum.service.GuideSearch;
import com.sentum.util.GptAiUtils;
import com.sentum.util.GuideVOSorter;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.*;



@Service
@Slf4j
public class GuideSearchImpl implements GuideSearch {

    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private LxGptServiceImpl lxGptService;
    @Autowired
    private FormulaFeign formulaFeign;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private GptAiUtils gptAiUtils;

    // 西药检索
    @Override
    public GuideAndScore sdyPanel(String drugName, String disease, List<String> drugNames, List<String> diseases) {
        GuideAndScore guideAndScore = new GuideAndScore();


        List<GuideVO> guideVOS = lxGptService.queryGuideByDrugAndDisease(drugNames, drugName, diseases, disease);

        if (guideVOS.size() > 20) {
            guideVOS = guideVOS.subList(0, 20);
        }

        for (GuideVO guideVO : guideVOS) {
            if (guideVO.getBlock().length() > 2000) {
                guideVO.setBlock(guideVO.getBlock().substring(0, 2000));
            }
        }


        final int BATCH_SIZE = 10;

        // 存储最终结果
        JSONObject finalResult = new JSONObject();

        // 分批处理
        List<GuideVO> batch = new ArrayList<>();
        for (int i = 0; i < guideVOS.size(); i++) {
            batch.add(guideVOS.get(i));

            // 达到批次大小 或 已到最后一条，执行处理
            if (batch.size() == BATCH_SIZE || i == guideVOS.size() - 1) {
                // 构建当前批次的 prompt
                StringBuilder sb = new StringBuilder();
                JSONObject tempJson = new JSONObject(); // 用于接收该批次的预期结构

                for (GuideVO guide : batch) {
                    sb.append("#####**id:").append(guide.getId())
                            .append("**标题:").append(guide.getTitle())
                            .append("**内容:").append(guide.getBlock())
                            .append("**发布者:").append(guide.getZdz())
                            .append("**######\n");

                    // 构建预期返回结构
                    tempJson.put(guide.getId(), guide.getId() + "的总结");
                    tempJson.put(guide.getId() + "related", guide.getId() + "数据类型为boolean,相关性的判断");
                }


                String prompt = "请作为一名医学循证专家，对以下指南文献进行筛选与总结。我将提供包括指南ID和原文块（Blocks）的数据库。请按以下步骤处理：\n" +
                        "（1）首先，根据每篇指南的原文信息，判断每一篇指南与课题“【" + drugName + "】治疗【" + disease + "】”的相关性。若整篇指南中未同时涉及该药物和该疾病，或内容与治疗推荐无关，返回“false”，相关则返回‘true’返回类型为boolean类型。\n" +
                        "（2）总结“【" + drugName + "】治疗【" + disease + "】”的相关内容，则需要提取并总结原文中与“【" + drugName + "】治疗【" + disease + "】”直接相关的内容。\n" +
                        "注意：\n" +
                        "总结必须严格基于所提供的指南原文，不得引入外部知识或推断。\n" +
                        "所有总结的输出内容均以中文呈现。\n" +
                        "指南相关内容开始 ***********\n" +
                        sb.toString() +
                        "\n********** 指南相关内容结束";

                // 调用 AI 接口
                JSONObject batchResult;
                try {
                    batchResult = gptAiUtils.executeGptPlus(
                            prompt,
                            "指南总结",
                            "请严格以 JSON 格式返回：" + tempJson.toJSONString(),
                            "", ""
                    );
                } catch (Exception e) {
                    // 失败时给默认值
                    batchResult = new JSONObject();
                    for (GuideVO guide : batch) {
                        batchResult.put(guide.getId(), "调用失败");
                    }
                }

                // 合并结果到最终 JSON
                for (GuideVO guide : batch) {
                    String id = guide.getId();
                    Object summary = batchResult.get(id);
                    try {
                        Boolean related = batchResult.getBoolean(id + "related");
                        finalResult.put(id + "related", related);
                    } catch (Exception ex) {
                        batchResult.put(id + "related", false);
                        finalResult.put(id + "related", false);
                    }

                    if (summary != null) {
                        finalResult.put(id, summary);
                    } else {
                        // 若模型未返回该 id，默认为“不相关”或重试逻辑
                        finalResult.put(id, "不相关");
                    }
                }

                // 清空 batch，准备下一批
                batch.clear();
            }
        }

        ArrayList<GuideVO> guideVOSX = new ArrayList<>();
        for (GuideVO guideVO : guideVOS) {
            if (finalResult.getBoolean(guideVO.getId() + "related")) {
                guideVO.setGuideInfo(finalResult.getString(guideVO.getId()));
                guideVOSX.add(guideVO);
            }
        }


        List<GuideVO> guideVOList = new ArrayList<>();
        // 沒有分數的集合
        List<GuideVO> guideVOListx = new ArrayList<>();


        // 檢查庫里是否有這個指南
        for (GuideVO guideVO : guideVOSX) {
            boolean exists = mongoTemplate.exists(new Query(Criteria.where("guideId").is(guideVO.getId())), GuideScoreTableDto.class);
            if (exists) {
                GuideScoreTableDto guideScoreTableDto = mongoTemplate.findOne(new Query(Criteria.where("guideId").is(guideVO.getId())), GuideScoreTableDto.class);
                guideVO.setScorex(guideScoreTableDto.getScore());
                guideVOList.add(guideVO);
            } else {
                guideVOListx.add(guideVO);
            }
        }


        int scoreT = 0;
        ArrayList<GuideVO> guideVOS1 = new ArrayList<>();
        if (guideVOListx.size() > 0) {

            // 拼接文本
            StringBuilder text = new StringBuilder();
            HashMap<String, String> stringStringHashMap = new HashMap<>();

            for (GuideVO guideVO1 : guideVOListx) {
                text.append("#####**id:");
                text.append(guideVO1.getId());
                text.append("**标题:");
                text.append(guideVO1.getTitle());
                text.append("**内容:");
                text.append(guideVO1.getGuideInfo());
                text.append("**发布者:");
                text.append(guideVO1.getZdz());
                text.append("**######\n");

                stringStringHashMap.put(guideVO1.getId(), "id为" + guideVO1.getId() + "的评分");

            }
            JSONObject object1 = new JSONObject();
            stringStringHashMap.forEach((k, v) -> object1.put(k, v));


            String proptext = "请根据提供的指南信息，对指南进行打分，并以JSON格式反馈。若均不符合，返回\"无\"。\n" +
                    "筛选规则：\n" +
                    "12分：诊疗规范类：标题或类型含\"诊疗规范\"\"指导原则\"等关键词；\n" +
                    "12分：临床路径类：标题或类型明确提及\"临床路径\"；\n" +
                    "12分：国家级行政机构发布：发布机构为国家卫健委、国家卫生部等国家级卫生行政部门，且类型为\"共识\"或\"管理办法\"。" +
                    "12分：指南原文中提及Ⅰ级推荐+A级证据\n" +
                    "11分：指南原文中提及Ⅰ级推荐+B级证据\n" +
                    "10分：指南原文中提及Ⅰ级推荐+C级或者其他级别证据\n" +
                    "9分：指南原文中提及Ⅱ级及以下推荐+A级证据\n" +
                    "8分：指南原文中提及Ⅱ级及以下推荐+B级证据\n" +
                    "7分：指南原文中提及Ⅱ级及以下推荐+C级或者其他级别证据\n" +
                    "6分：制定者为学会且指南基于\"Meta分析/系统综述\"的专家共识\n" +
                    "5分：制定者为学会的普通专家共识\n" +
                    "4分：制定者为非学会的其他专家共识\n" +
                    "附加说明：\n" +
                    "同一指南满足多条规则时按最高分计算。\n" +
                    "若指南的发布机构或者原文内容不能根据以上评分规则进行划分的，请给6分。" +
                    "指南信息如下：" +
                    text +
                    "返回以json返回，字段名为指南id，值为所得分数（分数为阿拉伯数字）例如：{ \"id1\":\"12\" },每个指南id都要进行打分(不能給阿拉伯数字以外的內容,无法判断的指南为6分),具体你要返回的json格式为：" +
                    object1.toJSONString();

            JSONObject object = gptAiUtils.executeGptPlus(proptext, "指南打分", "注意:请严格按照我给出的json格式返回", "", "12,11,10,9,8,7,6,5,4");
            for (GuideVO guide : guideVOListx) {
                if (object.containsKey(guide.getId())) {
                    guide.setScorex(object.getString(guide.getId()));
                    guideVOS1.add(guide);
                    GuideScoreTableDto guideScoreTableDto = new GuideScoreTableDto();
                    guideScoreTableDto.setGuideId(guide.getId());
                    guideScoreTableDto.setScore(object.getString(guide.getId()));
                    guideScoreTableDto.setTitle(guide.getTitle());
                    guideScoreTableDto.setPublishPerson(guide.getZdz());
                    guideScoreTableDto.setSource(guide.getCc());
                    mongoTemplate.save(guideScoreTableDto);

                }
            }
        }

        guideVOS1.addAll(guideVOList);


        // 获取最大分数
        for (GuideVO guideVO : guideVOS1) {
            try {
                int i1 = Integer.parseInt(guideVO.getScorex());
                if (i1 > scoreT) {
                    scoreT = i1;
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        guideAndScore.setScore(scoreT + "");
        guideAndScore.setGuideVOS(guideVOS1);


        return guideAndScore;
    }


    @Override
    public GuideAndScore vaePanel(
            String drugName,
            String disease,
            List<String> drugNames,
            List<String> diseases,
            String scoringRules  // ✅ 打分规则作为参数传入
    ) {
        GuideAndScore guideAndScore = new GuideAndScore();

        // 默认疾病描述
        if (StringUtils.isEmpty(disease)) {
            disease = "此药适用的疾病";
        }

        // Step 1: 检索指南（最多20条）
        List<GuideVO> guideVOS = StringUtils.isNotEmpty(disease) && !disease.equals("此药适用的疾病")
                ? lxGptService.queryGuideByDrugAndDisease(drugNames, drugName, diseases, disease)
                : lxGptService.queryGuideByDrugAndDiseaseTr(drugNames, drugName, null, "");

        if (guideVOS.size() > 20) {
            guideVOS = guideVOS.subList(0, 20);
        }

        // 截断 block 内容防止过长
        for (GuideVO guide : guideVOS) {
            if (StringUtils.isEmpty(guide.getBlock())) {
                guide.setBlock(guide.getPdf_txt());
            }

            if (StringUtils.isEmpty(guide.getBlock())) {
                guide.setBlock("");
            }
            if (guide.getBlock().length() > 2000) {
                guide.setBlock(guide.getBlock().substring(0, 2000));
            }

        }

        // 如果无指南，直接返回
        if (guideVOS.isEmpty()) {
            guideAndScore.setScore("0");
            guideAndScore.setGuideVOS(new ArrayList<>());
            return guideAndScore;
        }

        // Step 2: 构建输入文本
        StringBuilder inputText = new StringBuilder();
        JSONObject expectedJson = new JSONObject(); // 用于指导 AI 输出格式

        for (GuideVO guide : guideVOS) {
            inputText.append("#####**id:").append(guide.getId())
                    .append("**标题:").append(guide.getTitle())
                    .append("**内容:").append(guide.getBlock())
                    .append("**发布者:").append(guide.getZdz())
                    .append("**######\n");

            // 定义每个 ID 应返回的结构
            JSONObject item = new JSONObject();
            item.put("related", false);           // boolean
            item.put("summary", "");              // string
            item.put("score", "0");               // string，兜底6分
            expectedJson.put(guide.getId(), item);
        }

        // ✅ 主 Prompt：整合三合一任务（相关性 + 总结 + 打分），支持外部传入规则
        String prompt = "请作为一名医学循证专家，对以下指南文献进行综合评估。\n" +
                "您的任务是针对每篇指南完成三项操作：\n" +
                "\n【任务说明】\n" +
                "1. 判断相关性（related）：\n" +
                "   - 若指南中未同时提及药物【" + drugName + "】和疾病【" + disease + "】，或无明确治疗推荐，则视为不相关，返回 false；\n" +
                "   - 否则返回 true。\n" +
                "\n2. 内容总结（summary）：\n" +
                "   - 若 related 为 true，请基于原文总结关于【" + drugName + "】治疗【" + disease + "】的关键信息，包括推荐意见、适用人群、证据等级等，；\n" +
                "   - 若 false，summary 可为空字符串。\n" +
                "    注意：总结使用中文，不要出现“节选”字眼" +
                "\n3. 指南打分（score）：\n" +
                "   - 请根据以下评分规则进行打分，并返回对应分数（仅阿拉伯数字字符串，如\"12\"）：\n" +
                scoringRules + "\n" +  // ✅ 外部传入的打分规则
                "   - 同一指南取最高分项；若不符合任何规则，默认返回 \"0\"。\n" +
                "\n【输出要求】\n" +
                "- 必须返回合法 JSON 对象；\n" +
                "- key 为指南 id；\n" +
                "- value 为包含字段：\"related\"(boolean), \"summary\"(string), \"score\"(string) 的对象；\n" +
                "- 不要添加额外字段、注释或解释；\n" +
                "- 所有字符串使用中文。\n" +
                "\n【输入数据】\n" +
                "*********** 指南相关内容开始\n" +
                inputText.toString() +
                "*********** 指南相关内容结束";

        // 明确期望输出结构（用于 instruction）
        String instruction = "请严格按照以下 JSON 结构返回结果：" + expectedJson.toJSONString() +
                "\n注意：\n" +
                "- related 字段必须是 boolean 类型（true/false），不能是字符串；\n" +
                "- score 必须是双引号包裹的字符串（如 \"12\"），不可为数字类型；\n" +
                "- 若不确定，related 设为 false，score 设为 \"6\"。";

        // Step 3: 调用 AI 一次完成所有任务
        JSONObject aiResult;
        try {
            aiResult = gptAiUtils.executeGptPlus(prompt, "指南综合评估", instruction, "", "");
        } catch (Exception e) {
            log.error("AI 综合评估调用失败", e);
            aiResult = new JSONObject();
        }

        // Step 4: 解析结果并构建返回对象
        List<GuideVO> validGuides = new ArrayList<>();
        int maxScore = 0;

        for (GuideVO guide : guideVOS) {
            String id = guide.getId();
            JSONObject resultItem = aiResult.getJSONObject(id);

            // 安全解析
            Boolean related = parseSafeBoolean(resultItem, "related", false);
            String summary = resultItem.getString("summary");
            String rawScore = parseValidScore(resultItem.getString("score"));

            // 只保留相关的指南
            if (Boolean.TRUE.equals(related)) {
                guide.setGuideInfo(StringUtils.isEmpty(summary) ? "无具体内容" : summary);
                guide.setScorex(rawScore);
                validGuides.add(guide);

                // 更新最高分
                try {
                    int s = Integer.parseInt(rawScore);
                    if (s > maxScore) maxScore = s;
                } catch (NumberFormatException ignored) {}
            }
        }

        // Step 5: 设置返回值
        guideAndScore.setScore(String.valueOf(maxScore));
        guideAndScore.setGuideVOS(validGuides);
        return guideAndScore;
    }

// --- 辅助方法 ---

    /**
     * 安全解析 boolean 字段
     */
    private Boolean parseSafeBoolean(JSONObject json, String key, Boolean defaultValue) {
        try {
            Object val = json.get(key);
            if (val == null) return defaultValue;
            if (val instanceof Boolean) return (Boolean) val;
            return Boolean.parseBoolean(val.toString());
        } catch (Exception e) {
            return defaultValue;
        }
    }

    /**
     * 验证 score 是否合法，非法则返回兜底 "6"
     */
    private String parseValidScore(String score) {
        if (score == null) return "0";
        return score.trim().matches("^(12|11|10|9|8|7|6|5|4|3|2|1|0)$") ? score.trim() : "0";
    }



    private com.alibaba.fastjson.JSONObject getResponseFormat(Map<String, String> format) {
        com.alibaba.fastjson.JSONObject responseFormat = new com.alibaba.fastjson.JSONObject();
        com.alibaba.fastjson.JSONObject json_schema = new com.alibaba.fastjson.JSONObject();
        com.alibaba.fastjson.JSONObject schema = new com.alibaba.fastjson.JSONObject();
        com.alibaba.fastjson.JSONObject properties = new com.alibaba.fastjson.JSONObject();
        responseFormat.put("type", "json_schema");   // gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  // gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   // gpt未说明   固定
        json_schema.put("strict", true);  // 开启固定格式

        schema.put("additionalProperties", false);
        ArrayList<String> strings = new ArrayList<>();// 此对象包含的字段
        format.forEach((k, v) -> {                  // 组装此对象的所有字段
            com.alibaba.fastjson.JSONObject propertie = new JSONObject();
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


    public TrGuideVo getGuideWithCache(List<String> drugZhs, String drugZh) {

        TrGuideVo trGuideVo = new TrGuideVo();
        ArrayList<GuideVO> guideVOS1 = new ArrayList<>();
        trGuideVo.setGuideVOList(guideVOS1);

        // 缓存中不存在数据，执行查询
        List<GuideVO> guideVOS = lxGptService.queryGuideByDrugAndDiseaseTr(drugZhs, drugZh, null, "");
        // 打分結果集合
        List<GuideVO> guideVOList = new ArrayList<>();
        // 沒有分數的集合
        List<GuideVO> guideVOListx = new ArrayList<>();


        if (guideVOS != null) {
            // 檢查庫里是否有這個指南
            for (GuideVO guideVO : guideVOS) {
                boolean exists = mongoTemplate.exists(new Query(Criteria.where("guideId").is(guideVO.getId())), GuideScoreTableTrDto.class);
                if (exists) {
                    GuideScoreTableTrDto guideScoreTableDto = mongoTemplate.findOne(new Query(Criteria.where("guideId").is(guideVO.getId())), GuideScoreTableTrDto.class);
                    guideVO.setScorex(guideScoreTableDto.getScore());
                    guideVOList.add(guideVO);
                } else {
                    guideVOListx.add(guideVO);
                }
            }

        }

        if (CollUtil.isNotEmpty(guideVOListx)) {
            StringBuilder stringBuildertext = new StringBuilder();
            HashMap<String, String> stringStringHashMap = new HashMap<>();
            for (GuideVO guideVO : guideVOListx) {
                stringBuildertext.append("#####**id:");
                stringBuildertext.append(guideVO.getId());
                stringBuildertext.append("**标题:");
                stringBuildertext.append(guideVO.getTitle());
                stringBuildertext.append("**发布者:");
                stringBuildertext.append(guideVO.getZdz());
                stringBuildertext.append("**######\n");
                stringStringHashMap.put(guideVO.getId(), "id为" + guideVO.getId() + "的打分结果");


            }

            JSONObject object = new JSONObject();
            stringStringHashMap.forEach((k, v) -> {
                object.put(k, v);
            });
            // String format = "作为医学指南专家给我指南打分：给出多篇指南，请按照json格式返回，返回具体内容为"


            String prompt = "请根据给定的指南相关信息，根据以下评分规则，对与“" + drugZh + "”相关的指南进行评分。评分规则如下：" +
                    "诊疗规范（关键词：诊疗规范、指导原则）：10分\n" +
                    "中成药治疗优势病种临床应用指南（关键词：指南标题中带有“中成药治疗”及“临床应用指南”字样）：10分（示例：中成药治疗痛经临床应用指南（2021年））\n" +
                    "属于指南，且需是由国家级学会（如：中华医学会、中国药学会、中华中医药学会、欧洲心脏病学会等，具体可参见《中华人民共和国国家一级学会目录》）组织发布的指南：9分\n" +
                    "属于指南，除了国家级学会的其他级别学会（如：省级学会/协会、市级学会/协会、区县级学会/协会、高校或医院内部学会、行业或跨区域联合学会、国际学会的中国分支机构等）组织发布的指南：8分\n" +
                    "属于共识，由国家级学会组织（如：中华医学会、中国药学会、中华中医药学会、欧洲心脏病学会等，可参见《中华人民共和国国家一级学会目录》）发布的专家共识：7分\n" +
                    "属于共识，除了国家级学会的其他级别学会（如：省级学会/协会、市级学会/协会、区县级学会/协会、高校或医院内部学会、行业或跨区域联合学会、国际学会的中国分支机构等）组织发布的共识：6分\n" +
                    "***注意事项：（1）只要指南标题中没有出现'共识'两个字，就算作'指南'。按照以上评分规则给分。（2）指南标题中明确提及“指南”两个字时，不能给6分或者7分，需要按照指南来打分。（3）只要指南标题中出现'共识'就只能给6或7分，具体打分标准需要看共识的发布机构，属于世界级学会或国家级学会发布的共识，给7分；属于除了国家级学会以外的组织发布的共识，给6分。" +
                    "$$$$$$$$$$$返回规则：严格按照json格式返回，json中的key为id（每个id都要返回），value为打分结果（要求阿拉伯数字，类型为数字，最低为6分）"
                    + "给定的指南标题、发布机构以及相关原文信息如下：" + stringBuildertext + "\n\n" + "需要返回的字段（json格式返回）：" +
                    object.toJSONString();

            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject jsonObject = gptAiUtils.executeGptPlus(prompt, "指南", "注意：严格按照提示的json格式化返回", "", "10,9,8,7,6");

            for (GuideVO voListx : guideVOListx) {
                if (jsonObject.containsKey(voListx.getId())) {
                    
                    voListx.setScorex(jsonObject.getString(voListx.getId()));
                    GuideScoreTableTrDto guideScoreTableTrDto = new GuideScoreTableTrDto();
                    guideScoreTableTrDto.setTitle(voListx.getTitle());
                    guideScoreTableTrDto.setGuideId(voListx.getId());
                    guideScoreTableTrDto.setScore(voListx.getScorex());
                    guideScoreTableTrDto.setPublishPerson(voListx.getZdz());
                    mongoTemplate.insert(guideScoreTableTrDto, "evaluation_guide_score_tr");
                    guideVOList.add(voListx);
                }
            }
        }


        if (CollUtil.isNotEmpty(guideVOList)) {
            List<GuideVO> guideVOS2 = GuideVOSorter.sortGuideVOList(guideVOList, drugZhs, drugZhs);
            // 多余十篇取前十
            GuideAndScore guideAndScore = new GuideAndScore();
            guideAndScore.setGuideVOS(guideVOS2.size() > 10 ? guideVOS2.subList(0, 10) : guideVOS2);
            String scorex = guideAndScore.getGuideVOS().get(0).getScorex();
            try {
                trGuideVo.setScore(Double.parseDouble(scorex));
            } catch (Exception e) {
                trGuideVo.setScore(6.0);
            }


            HashMap<String, String> stringStringHashMap2 = new HashMap<>();
            String guides = "";
            for (GuideVO guideVO : guideAndScore.getGuideVOS()) {

                String block = guideVO.getPdf_txt();

                if (StringUtils.isNotEmpty(guideVO.getPdf_txt()) && guideVO.getPdf_txt().length() > 3000) {
                    block = guideVO.getPdf_txt().substring(0, 3000);
                }

                guides = guides + "************指南id:" + guideVO.getId() + "***指南标题:" + guideVO.getTitle() + "***指南节选:" + block + "**********";
                stringStringHashMap2.put(guideVO.getId(), "指南id为" + guideVO.getId() + "的指南总结的内容（300字左右，原文什么语言则返回什么语言）");

            }

            JSONObject object = new JSONObject();
            stringStringHashMap2.forEach((k, v) -> {
                object.put(k, v);
            });


            String prompt2 = " 我现在正在研究" + drugZh + "的指南，请把下列指南每篇给我总结一段话，关于" + drugZh + "指南如下:"
                    + guides + "\n\n最后json返回,返回的字段名就是对应id，值为总结(返回的内容务必提及" + drugZh + ")，每一个出现的id都要返回对应的内容（不能返回空，总结内容中不要出现id），要返回的具体内容（json格式）：" +
                    object.toJSONString();
            JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);
            JSONObject jsonObject2 = gptAiUtils.executeGptPlus(prompt2, "指南总结", "注意：严格按照提示的json格式返回", "", null);

            for (GuideVO guideVO : guideAndScore.getGuideVOS()) {
                if (jsonObject2.containsKey(guideVO.getId())) {
                    guideVO.setPdf_txt(jsonObject2.getString(guideVO.getId()));
                    guideVOS1.add(guideVO);
                }
            }
        }

        trGuideVo.setGuideVOList(guideVOS1);

        return trGuideVo;
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
