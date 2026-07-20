package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.sentum.config.AIProviderConfig;
import com.sentum.constants.CommonConstants;
import com.sentum.constants.Constants;
import com.sentum.constants.PriorityConstants;
import com.sentum.constants.PromptConstant;
import com.sentum.enums.CommonPromptEnum;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.GptDemoEnum;
import com.sentum.feign.FineScreenFeign;
import com.sentum.infrastructure.handler.PriorityAwareAsyncScheduler;
import com.sentum.opcode.FormulaUtil;
import com.sentum.opcode.SearchFormula;
import com.sentum.pojo.*;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.LxGptService;
import com.sentum.service.StreamService;
import com.sentum.service.StreamTrService;
import com.sentum.infrastructure.handler.OrderedSSEWriter;
import com.sentum.util.*;
import com.sentum.util.utilsy.AIRequestUtils;
import com.sentum.util.utilsy.QueryUtils;
import com.sentum.util.utilsy.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections4.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.TermQueryBuilder;
import org.elasticsearch.index.query.functionscore.FieldValueFactorFunctionBuilder;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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
import java.io.IOException;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static com.sentum.service.impl.LxGptServiceImpl.*;

@Service
@Slf4j
public class StreamServiceImpl implements StreamService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private LxGptService lxGptService;
    @Autowired
    private StreamTrService streamTrService;
    @Autowired
    RedisTemplate<String, Object> redisTemplate;
    @Autowired
    private RetryUtils retryUtils;
    @Autowired
    private DrugInfoUtil drugInfoUtil;
    @Value("${gpt.isNew}")
    private boolean isNew;
    @Autowired
    private GptAiUtils gptAiUtils;
    @Autowired
    private AIProviderConfig aiProviderConfig;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private GptCallUtil gptCallUtil;

    private final static Integer GPT_REDIS_TIME = 24;
    private final static String GPT_REDIS_KEY = "evaluation_gpt_score:";

    @Value("${sys.isDev}")
    private String isDev;

    private String getGptRedis(String md5) {
        String key = GPT_REDIS_KEY + md5;
        if (redisTemplate.hasKey(key)) {
            String s = (String) redisTemplate.opsForValue().get(key);
            redisTemplate.expire(key, GPT_REDIS_TIME, TimeUnit.HOURS);
            return s;
        }
        return "";
    }

    private static final Map<String, Double> DIGIT_MAP = new HashMap<>();

    static {
        DIGIT_MAP.put("每日一次", 1.0);
        DIGIT_MAP.put("每日两次", 2.0);
        DIGIT_MAP.put("每日三次", 3.0);
        DIGIT_MAP.put("每日四次", 4.0);
        DIGIT_MAP.put("每晚一次", 1.0);
        DIGIT_MAP.put("每周一次", 1.0);
        DIGIT_MAP.put("隔周一次", 1.0);
        DIGIT_MAP.put("必要时一次", 1.0);
        DIGIT_MAP.put("四小时一次", 6.0);
        DIGIT_MAP.put("六小时一次", 4.0);
        DIGIT_MAP.put("八小时一次", 3.0);
        DIGIT_MAP.put("12 小时一次", 2.0);
        DIGIT_MAP.put("立即", 1.0);
        DIGIT_MAP.put("一小时一次", 24.0);
        DIGIT_MAP.put("二小时一次", 12.0);
        DIGIT_MAP.put("三小时一次", 8.0);
        DIGIT_MAP.put("每30分钟1次", 24.0); // 60 / 30 = 2
        DIGIT_MAP.put("每小时1次", 24.0);
        DIGIT_MAP.put("每3小时1次", 8.0);
        DIGIT_MAP.put("每 72小时一次", 1.0);
        DIGIT_MAP.put("每日3次餐前", 3.0);
        DIGIT_MAP.put("每日5次", 5.0);
        DIGIT_MAP.put("隔日1次", 1.0);
        DIGIT_MAP.put("每3天1次", 1.0);
        DIGIT_MAP.put("每周3次", 1.0);
        DIGIT_MAP.put("每周2次", 1.0);
        DIGIT_MAP.put("每2周1次", 1.0);
        DIGIT_MAP.put("每3周1次", 1.0);
        DIGIT_MAP.put("每4周1次", 1.0);
        DIGIT_MAP.put("每月2次", 1.0);
        DIGIT_MAP.put("每月1次", 1.0);
        DIGIT_MAP.put("一次", 1.0);
        DIGIT_MAP.put("餐前", 1.0);
        DIGIT_MAP.put("餐中", 1.0);
        DIGIT_MAP.put("餐后", 1.0);
        DIGIT_MAP.put("每周4次", 1.0);
        DIGIT_MAP.put("每周5次", 1.0);
        DIGIT_MAP.put("每周6次", 1.0);
        DIGIT_MAP.put("每 10 天1次", 1.0);
        DIGIT_MAP.put("每日8次", 8.0);
        DIGIT_MAP.put("每早1次", 1.0);
        DIGIT_MAP.put("每睡前 1 次", 1.0);
        DIGIT_MAP.put("每餐前 1次", 1.0);
        DIGIT_MAP.put("每餐后 1 次", 1.0);
        DIGIT_MAP.put("隔日2次", 1.0);
        DIGIT_MAP.put("隔日3次", 1.0);
        DIGIT_MAP.put("隔日4次", 1.0);
        DIGIT_MAP.put("隔日5次", 1.0);
        DIGIT_MAP.put("隔日6次", 1.0);
        DIGIT_MAP.put("隔日7次", 1.0);
        DIGIT_MAP.put("隔日8次", 1.0);
    }

    @Override
    public JSONObject guidePanel(String drugId, String disease, String id, long userId, String userName, HttpServletResponse response) {
        Boolean isExist = this.redisTemplate.hasKey("gpt:" + id + ":" + 0);
        JSONObject result = new JSONObject();

        DrugInfoNew drugInfo = drugInfoUtil.getDrugInfo(drugId, id);
//        List<JSONObject> jsonObjects = null;
//        if ("1".equals(isDev)){
////              jsonObjects = ChangeMongoUtil.mongo.find(new Query(Criteria.where("title").is(drugInfo1.getDrugName() + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer())), JSONObject.class, "evaluation_wm_cache");
//        }else {
//            jsonObjects = mongoTemplate.find(new Query(Criteria.where("title").is(drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer()+"-"+disease)), JSONObject.class, "evaluation_wm_cache");
//        }
        
//        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("title").is(drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer()+"-"+disease)), JSONObject.class, "evaluation_wm_cache");

//        if (CollUtil.isNotEmpty(jsonObjects)) {
//            JSONObject jsonObject = jsonObjects.get(0);
//            JSONArray info = jsonObject.getJSONArray("info");
//            for (CacheDto cacheDto : info.toJavaList(CacheDto.class)) {
//                writeCache(cacheDto,response);
//            }
//            return null;
//        }

        if (Objects.isNull(isExist) || !isExist) {
            String drugName = drugInfo.getDrugName();
            String enterpriseName = drugName;

            result.put("disease", disease);
            result.put("ts", System.currentTimeMillis());

            // 用来存放drug 和 disease同义词list
            List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
            List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

            //拼接返回前端
            List<CacheDto> stringBuilder = new ArrayList<>();
            long begin = System.currentTimeMillis();
            int step = 0;

            // 获取同义词
            GetSynonyms(drugName, drugs, disease, diseases);
            // 此处存储的key 与 value 的值在获取同义词接口出保存
            String redis_key = "synonym:" + userId;
            String synonym = RedisUtils.getStr(redis_key);
            if (StringUtils.isNotBlank(synonym)) {
                List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {});
                for (SynonymVo synonymVo : synonymVos) {
                    // 表明输入词有药
                    if (Integer.parseInt(synonymVo.getType()) == 1) {
                        // 要所有已勾选的同义词
                        drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
                        // 排除所有反勾选的同义词
                        drugs.removeAll(synonymVo.getExcludeSynonyms());
                    }
                }
            }

            Map<String, Future<Boolean>> futureResult = new HashMap<>();
            Map<String, JSONObject> gptAnalysisMap = new HashMap<>();
            Map<GuideVO, JSONObject> guideEffectiveMap = new HashMap<>();
            Map<GuideVO, JSONObject> guideOldEffectiveMap = new HashMap<>();
            Map<Literature, JSONObject> literatureMap = new HashMap<>();
            
            // write("start", drugInfo1.getDrugName() + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer(), response, stringBuilder,"标题");
            //            lxGptService.useThreadPoolExecutePrompt(drugName, disease, drugInfo, enterpriseName, futureResult, gptAnalysisMap, guideEffectiveMap, guideOldEffectiveMap, literatureMap, new DrugAddDto(), drugs, diseases);
            //             1.药学特性分析
//                        step = pharmacyAnalysis(drugName, disease, drugInfo, step, id, result, stringBuilder, response);
            //             2.有效性部分
//                        step = effectiveAnalysis(drugName, disease, drugInfo, step, id, result, futureResult, gptAnalysisMap, guideEffectiveMap, guideOldEffectiveMap, literatureMap, stringBuilder, response);
            //             3.安全性
//                        step = safetyAnalysis(drugName, disease, drugInfo, step, id, result, futureResult, gptAnalysisMap, stringBuilder, response);
            //             5.其他
//                        step = otherAnalysis(drugName, disease, drugInfo, step, id, result, enterpriseName, futureResult, gptAnalysisMap, stringBuilder, response);
            //            write("end", drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer(), response, stringBuilder,"标题");
            //            
            
            log.info("用户{}, 西药课题{}", userName, drugInfo.getDrugName());
            PriorityAwareAsyncScheduler scheduler = new PriorityAwareAsyncScheduler(3);
            // 🔥 关键：每个请求创建独立的 Writer 实例
            // ✅ 每个用户都有自己的 OrderedSSEWriter 实例
            List<CacheDto> cacheDtos = new ArrayList<>();
            OrderedSSEWriter writer = new OrderedSSEWriter(Constants.REPORT_FIELDS_LIST_WEST, response, cacheDtos);
            writer.write("start", drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer(), "begin");
            Date concurrenceData = new Date();

            // 第一模块
            CompletableFuture<Double> pharmacologyFuture = scheduler.submit(50, () -> {
                String pharmacologyStr = "";
                String pharmacology = drugInfo.getPharmacology();
                if (StringUtils.isNotBlank(pharmacology)) {
                    pharmacologyStr += pharmacology;
                }
                String toxicological = drugInfo.getToxicological();
                if (StringUtils.isNotBlank(toxicological)) {
                    pharmacologyStr += toxicological;
                }
                String mechanismAction = drugInfo.getMechanismAction();
                if (StringUtils.isNotBlank(mechanismAction)) {
                    pharmacologyStr += mechanismAction;
                }

                if (StringUtils.isNotEmpty(pharmacologyStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出药理作用相关内容");
                    resField.put("analysis", "分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.PHARMACOLOGY_PROMPT, pharmacologyStr, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "药理作用得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("pharmacologyScore", score, "药理作用得分");
                    writer.write("pharmacology", content, "药理作用");
                    return Double.parseDouble(score);
                } else {
                    writer.write("pharmacologyScore", "", "药理作用得分");
                    writer.write("pharmacology", "", "药理作用");

                    return 0.0; 
                }
            });
            CompletableFuture<Double> pharmacokineticsFuture = scheduler.submit(49, () -> {
                String pharmacokinetics = drugInfo.getPharmacokinetics();

                if (StringUtils.isNotEmpty(pharmacokinetics)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出体内过程相关内容");
                    resField.put("analysis", "分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pharmacokineticsPrompt = PromptConstant.getPrompt(PromptConstant.PHARMACOKINETICS_PROMPT, pharmacokinetics, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(pharmacokineticsPrompt, JSONObject.class, "药代动力学得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("pharmacokineticsScore", score, "药代动力学得分");
                    writer.write("pharmacokinetics", content, "药代动力学");
                    return Double.parseDouble(score);
                } else {
                    writer.write("pharmacokineticsScore", "", "药代动力学得分");
                    writer.write("pharmacokinetics", "", "药代动力学");
                    return 0.0;
                }
            });
            CompletableFuture<Double> pharmacyMethodFuture = scheduler.submit(48, () -> {
                float pharmacyMethodScore = 0;

                String ingredient = drugInfo.getIngredient();

                if (StringUtils.isNotEmpty(ingredient)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出主要成分与辅料内容");
                    resField.put("analysis", "分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String onePrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_ONE, drugName, ingredient, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(onePrompt, JSONObject.class, "主要成分与辅料得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    if (ingredient.contains("辅料")) {
                        writer.write("componentScore", 2, "主要成分与辅料得分");
                        writer.write("component", content, "主要成分与辅料");
                        pharmacyMethodScore += 2;
                    } else {
                        writer.write("componentScore", score, "主要成分与辅料得分");
                        writer.write("component", content, "主要成分与辅料");
                        pharmacyMethodScore += Float.parseFloat(score);
                    }

                } else {
                    writer.write("componentScore", "", "主要成分与辅料得分");
                    writer.write("component", "", "主要成分与辅料");
                    pharmacyMethodScore += 0;
                }

                String specifications = drugInfo.getSpecifications();
                String pack = drugInfo.getPack();
                String usageAndDosage = drugInfo.getUsageAndDosage();
                String drugInfoStr = drugInfo.toString();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "请提取出非空的规格与包装相关内容，省略空或null的部分");
                resField.put("analysis", "得分原因的分析过程");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String twoPrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_TWO, specifications, pack, drugInfoStr, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(twoPrompt, JSONObject.class, "规格与包装得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String score = aiResult.getString("score");
                String content = aiResult.getString("content");
                
                writer.write("packageScore", score, "规格与包装得分");
                writer.write("package", content, "规格与包装");
                pharmacyMethodScore += Float.parseFloat(score);


                String dosageForm = drugInfo.getDosageForm();

                resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "请提取出剂型相关内容");
                resField.put("analysis", "得分原因");
                properties = new JSONObject();
                properties.putAll(resField);
                String threePrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_THREE, drugName, dosageForm, JSON.toJSONString(properties));
                aiResult = retryUtils.executeWithRetry(threePrompt, JSONObject.class, "剂型得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                score = aiResult.getString("score");
                content = aiResult.getString("content");
                writer.write("dosageFormScore", score, "剂型得分");
                writer.write("dosageForm", content, "剂型");
                pharmacyMethodScore += Float.parseFloat(score);


                resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "请提取出给药剂量相关内容");
                resField.put("analysis", "得分原因");
                properties = new JSONObject();
                properties.putAll(resField);
                String fourPrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_FOUR, drugName, disease, diseases, drugInfoStr, JSON.toJSONString(properties));
                aiResult = retryUtils.executeWithRetry(fourPrompt, JSONObject.class, "给药剂量得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                score = aiResult.getString("score");
                content = aiResult.getString("content");
                writer.write("doseScore", score, "给药剂量得分");
                writer.write("dose", content, "给药剂量");
                pharmacyMethodScore += Float.parseFloat(score);


                resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "请提取出给药频次内容");
                resField.put("analysis", "得分原因");
                properties = new JSONObject();
                properties.putAll(resField);
                String fivePrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_FIVE, drugName, disease, diseases, drugInfoStr, JSON.toJSONString(properties));
                aiResult = retryUtils.executeWithRetry(fivePrompt, JSONObject.class, "给药频次得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                score = aiResult.getString("score");
                String analysis = aiResult.getString("analysis");
                content = aiResult.getString("content");
                writer.write("drugFrequencyScore", score, "给药频次得分");
                if (StringUtils.isNotBlank(content)) {
                    writer.write("drugFrequency", content, "给药频次");
                } else {
                    writer.write("drugFrequency", analysis, "给药频次");
                }
                pharmacyMethodScore += Float.parseFloat(score);
               
                return (double)pharmacyMethodScore;
            });
            CompletableFuture<Double> useMethodFuture = scheduler.submit(47, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotEmpty(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出关于使用方法相关内容");
                    resField.put("analysis", "分析过程（100字内，简述步骤1的决策依据和维度简析，禁止输出推理过程或条件匹配说明（例如，不得输出“符合步骤1第一条核心条件”等解释性内容））");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String sevenPrompt = PromptConstant.getPrompt(PromptConstant.PHARMACY_METHOD_PROMPT_SEVEN, drugName, JSON.toJSONString(properties), drugInfoStr);
                    JSONObject aiResult = retryUtils.executeWithRetry(sevenPrompt, JSONObject.class, "使用方法得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");
                    writer.write("convenienceScore", score, "使用方法得分");
                    writer.write("convenience", content, "使用方法");
                    return Double.parseDouble(score);
                } else {
                    writer.write("convenienceScore", "", "使用方法得分");
                    writer.write("convenience", "", "使用方法");
                    return 0.0;
                }
            });
            CompletableFuture<Double> oneThreePartFuture = CompletableFuture.allOf(
                    pharmacyMethodFuture, useMethodFuture
            ).thenApply(v -> {
                // 在这里可以安全地调用 join 来获取结果
                double pharmacyMethodScore = pharmacyMethodFuture.join();
                double useMethodScore = useMethodFuture.join();

                double total = pharmacyMethodScore + useMethodScore;
                writer.write("usageAndDosageScore", total, "第一模块第三部分总得分");
                return total;
            });
            CompletableFuture<Double> storageWestFuture = scheduler.submit(46, () -> {
                String storage = drugInfo.getStorage();

                if (StringUtils.isNotEmpty(storage)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "原文内容");
                    resField.put("analysis", "得分分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String storagePrompt = PromptConstant.getPrompt(PromptConstant.STORAGE_PROMPT_WEST, drugName, storage, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(storagePrompt, JSONObject.class, "贮藏得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");

                    writer.write("storageScore", score, "贮藏得分");
                    writer.write("storage", storage, "贮藏");
                    return Double.parseDouble(score);
                } else {
                    writer.write("storageScore", "", "贮藏得分");
                    writer.write("storage", "", "贮藏");
                    return 0.0;
                }
            });
            CompletableFuture<Double> indateFuture = scheduler.submit(45, () -> {
                String indate = drugInfo.getIndate();

                if (StringUtils.isNotEmpty(indate)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "原文内容");
                    resField.put("analysis", "得分分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String indatePrompt = PromptConstant.getPrompt(PromptConstant.INDATE_PROMPT, drugName, indate, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(indatePrompt, JSONObject.class, "有效期得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");

                    writer.write("indateScore", score, "有效期得分");
                    writer.write("indate", indate, "有效期");
                    return Double.parseDouble(score);
                } else {
                    writer.write("indateScore", "", "有效期得分");
                    writer.write("indate", "", "有效期");
                    return 0.0;
                }
            });
            CompletableFuture<Double> onePartFuture = CompletableFuture.allOf(
                    pharmacologyFuture, pharmacokineticsFuture, oneThreePartFuture, storageWestFuture, indateFuture
            ).thenApply(v -> {
                // 在这里可以安全地调用 join 来获取结果
                double pharmacologyScore = pharmacologyFuture.join();
                double pharmacokineticsScore = pharmacokineticsFuture.join();
                double oneThreePartScore = oneThreePartFuture.join();
                double storageWestScore = storageWestFuture.join();
                double indateScore = indateFuture.join();

                double total = pharmacologyScore + pharmacokineticsScore + oneThreePartScore + storageWestScore + indateScore;
                writer.write("characteristicScore", total, "第一模块总得分");
                return total;
            });
            
            // 第二模块
            List<String> finalDrugs = drugs;
            CompletableFuture<List<JSONObject>> searchGuideFuture = scheduler.submit(80, () -> {
                if (StringUtils.isNotEmpty(drugInfo.getDrugZh())) {
                    GetSynonyms(drugInfo.getDrugZh(), finalDrugs, disease, diseases);
                }else {
                    GetSynonyms(drugInfo.getDrugName(), finalDrugs, disease, diseases);
                }
                List<String> list = gptCallUtil.splitDisease(disease);
                diseases.addAll(list);
                // 去重：同义词扩展 + splitDisease 可能导致重复
                List<String> distinctDrugs = finalDrugs.stream().distinct().collect(Collectors.toList());
                List<String> distinctDiseases = diseases.stream().distinct().collect(Collectors.toList());
                finalDrugs.clear();
                finalDrugs.addAll(distinctDrugs);
                diseases.clear();
                diseases.addAll(distinctDiseases);

                BoolQueryBuilder guideQuery = new BoolQueryBuilder();
                guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
                guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

                guideQuery.must().add(QueryUtils.createGuideQuery(drugInfo.getDrugZh(), new HashSet<>(finalDrugs)));
                guideQuery.must().add(QueryUtils.createGuideQuery(disease, new HashSet<>(diseases)));
                
                String scriptStr = "double baseScore = Math.log1p(_score + 1) * 0.5; " +
                        "String name = doc['name'].value; " +
                        "if (name != null && name.indexOf('联合') >= 0) { " +
                        "    return baseScore * 0.5; " +
                        "} " +
                        "return baseScore;";
                Script script = new Script(scriptStr);
                ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);

                FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");

                FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
                filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
                filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);

                FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
                functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
                functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
                nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

                nativeSearchQuery.setMaxResults(40);
                SearchHits<GuideIndex> guideHits = null;
                try {
                    guideHits = RetryUtils.retry(
                            () -> elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class),
                            3,
                            1000,  // 每次重试间隔1秒
                            e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                    );
                    // 使用guideHits做后续处理
                } catch (Exception e) {
                    log.error("Search operation failed after retries", e);
                    // 这里可以做失败后降级或补偿逻辑
                }

                ExecutorService executorService = Executors.newFixedThreadPool(6);

                List<CompletableFuture<Void>> futures = new ArrayList<>();
                List<JSONObject> finalGuideList = new ArrayList<>();
                AtomicInteger successCount = new AtomicInteger(0);
                AtomicBoolean shouldStop = new AtomicBoolean(false);

                if (guideHits != null) {
                    for (SearchHit<GuideIndex> guideHit : guideHits) {
                        // 如果已经达到限制，不再提交新任务
                        if (shouldStop.get()) {
                            break;
                        }

                        GuideIndex guideIndex = guideHit.getContent();

                        JSONObject guideInfo = new JSONObject();
                        String guideId = guideIndex.getId();
                        guideInfo.put("id", guideId);
                        String title = guideIndex.getTitle();
                        guideInfo.put("title", title);

                        futures.add(CompletableFuture.runAsync(() -> {
                            try {
                                assembleGuide(guideId, finalGuideList, drugInfo.getDrugZh(), disease, finalDrugs, diseases, guideInfo, guideIndex, successCount, shouldStop);
                            } catch (Exception e) {
                                log.error(e.getMessage(), e);
                            }
                        }, executorService));
                    }
                }

                try {
                    CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
                } catch (CompletionException e) {
                    log.error(e.getMessage(), e);
                }
                executorService.shutdown();
                try {
                    if (!executorService.awaitTermination(100, TimeUnit.SECONDS)) {
                        executorService.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    executorService.shutdownNow();
                    Thread.currentThread().interrupt();
                }
                
                return finalGuideList;
            });
            CompletableFuture<Double> IndicationsFuture = searchGuideFuture.thenApply(finalGuideList -> {
                String indication = drugInfo.getIndications();
                if (!finalGuideList.isEmpty()) {
                    String indicationPrompt = PromptConstant.getPrompt(PromptConstant.INDICATION_GUIDE_PROMPT, disease, drugName, indication, finalGuideList.toString());
                    JSONObject aiResult = retryUtils.executeWithRetry(indicationPrompt, JSONObject.class, "适应症得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String process = aiResult.getString("process");
                    writer.write("indicationScore", score, "适应症得分");
                    writer.write("indication", process, "适应症");
                    return Double.parseDouble(score);
                } else {
                    String indicationPrompt = PromptConstant.getPrompt(PromptConstant.INDICATION_GUIDE_PROMPT, disease, drugName, indication, finalGuideList.toString());
                    JSONObject aiResult = retryUtils.executeWithRetry(indicationPrompt, JSONObject.class, "适应症得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                    String score = aiResult.getString("score");
                    String process = aiResult.getString("process");
                    writer.write("indicationScore", score, "适应症得分");
                    writer.write("indication", process, "适应症");
                    return Double.parseDouble(score);
                }         
            });
            CompletableFuture<Double> guideFuture = searchGuideFuture.thenApply(finalGuideList -> {
                if (!finalGuideList.isEmpty()) {
                    JSONArray guideInfos = new JSONArray();
                    double maxScore = 0.0;
                    for (JSONObject guideInfoObj : finalGuideList) {
                        String score = guideInfoObj.getString("score");
                        maxScore = Math.max(maxScore, Integer.parseInt(score));
                        String title = guideInfoObj.getString("title");
                        String zdz = guideInfoObj.getString("zdz");
                        String fbdate = guideInfoObj.getString("fbdate");
                        String block = guideInfoObj.getString("block");

                        JSONObject guideResEntity = new JSONObject();
                        guideResEntity.put("title", "《" + title + "》" + "-" + zdz + "-" + fbdate);
                        guideResEntity.put("content", block);
                        guideInfos.add(guideResEntity);
                    }
                    writer.write("guideScore", String.valueOf(maxScore), "指南得分");
                    writer.write("guide", guideInfos, "指南");
                    return maxScore;
                } else {
                    writer.write("guideScore", "0", "指南得分");
                    writer.write("guide", "", "指南");
                    return 0.0;
                }
            });
            CompletableFuture<Double> clinicalFuture = scheduler.submit(79, () -> {
                List<JSONObject> clinicalList = new ArrayList<>();
                String diseaseRemove = retryUtils.executeWithRetry(PromptConstant.getPrompt(PromptConstant.DISEASE_REMOVE_DECORATIONS_PROMPT, disease), String.class, "疾病修饰词去除", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                if (StringUtils.isNotBlank(diseaseRemove)) {
                    for (String dis : Arrays.stream(diseaseRemove.split("√")).collect(Collectors.toList())) {
                        Criteria criteria = new Criteria()
                                .and("condition").regex(dis, "i")
                                .andOperator(
                                        new Criteria().orOperator(
                                                Criteria.where("public_title").regex(drugName, "i"),
                                                Criteria.where("intervention.intervention").regex(drugName, "i")
                                        )
                                );

                        clinicalList = ReleaseMongoUtil.mongo.find(new Query(criteria), JSONObject.class, "clinical_trial_registration_new");

                        if (CollectionUtils.isEmpty(clinicalList)) {
                            Criteria criteria_bak = new Criteria()
                                    .and("condition").regex(dis, "i")
                                    .andOperator(
                                            new Criteria().orOperator(
                                                    Criteria.where("public_title").regex(drugInfo.getDrugZh(), "i"),
                                                    Criteria.where("intervention.intervention").regex(drugInfo.getDrugZh(), "i")
                                            )
                                    );

                            clinicalList = ReleaseMongoUtil.mongo.find(new Query(criteria_bak), JSONObject.class, "clinical_trial_registration_new");
                        }
                    }
                }
                
                StringBuilder clinicalBuilder = new StringBuilder();
                Set<String> mainIndicators = new HashSet<>();
                Set<String> secondaryIndicators = new HashSet<>();
                if (!clinicalList.isEmpty()) {
                    int t = 0;
                    for (JSONObject clinicalObj : clinicalList) {
                        t++;
                        JSONArray outcomes = clinicalObj.getJSONArray("outcomes");
                        for (int i = 0; i < outcomes.size(); i++) {
                            if ("主要指标".equals(outcomes.getJSONObject(i).getString("type"))) {
                                mainIndicators.add(outcomes.getJSONObject(i).getString("name").replaceAll("[。;]",""));
                            }
                            if ("次要指标".equals(outcomes.getJSONObject(i).getString("type"))) {
                                secondaryIndicators.add(outcomes.getJSONObject(i).getString("name").replaceAll("[。;]",""));
                            }
                        }
                    }

                    clinicalBuilder.append("查询").append(drugName).append("用于").append(disease).append("相关临床试验信息，临床疗效主要结局指标与次要结局指标情况汇总如下：");
                    
                    if (CollectionUtils.isNotEmpty(mainIndicators)) {
                        clinicalBuilder.append("\n主要结局指标：");
                        clinicalBuilder.append(CollUtil.join(mainIndicators, "、"));
                    }
                    if (CollectionUtils.isNotEmpty(secondaryIndicators)) {
                        clinicalBuilder.append("\n次要结局指标：");
                        clinicalBuilder.append(CollUtil.join(secondaryIndicators, "、"));
                    }

                    JSONObject resObj = new JSONObject();
                    resObj.put("process", clinicalBuilder.toString());

                    int mainCount = mainIndicators.isEmpty() ? 0 : 1;
                    int secondaryCount = secondaryIndicators.isEmpty() ? 0 : 1;
                    int score = (mainCount * 6) + (secondaryCount * 4); // 1*6+1*4=10, 1*6+0*4=6, 0*6+1*4=4, 0*6+0*4=0
                    resObj.put("score", score);

                    writer.write("effectivenessScore", score, "临床疗效得分");
                    writer.write("effectiveness", clinicalBuilder.toString(), "临床疗效");
                    return (double)score;
                } else {
                    writer.write("effectivenessScore", 0, "临床疗效得分");
                    writer.write("effectiveness", "", "临床疗效");
                    return 0.0;
                }
            });
            CompletableFuture<Double> twoPartFuture = CompletableFuture.allOf(
                    IndicationsFuture, guideFuture, clinicalFuture
            ).thenApply(v -> {
                // 在这里可以安全地调用 join 来获取结果
                double indicationsScore = IndicationsFuture.join();
                double guideScore = guideFuture.join();
                double clinicalScore = clinicalFuture.join();

                double total = indicationsScore + guideScore + clinicalScore;
                writer.write("effectiveScore", total, "第二模块总得分");
                return total;
            });
            
            // 第三模块
            CompletableFuture<Double> commonAdverseReactionsFuture = scheduler.submit(44, () -> {
                String adverseReaction = "";
                if (StringUtils.isNotBlank(drugInfo.getCommonAdverseReactions())) {
                    adverseReaction = "中度不良反应：" + drugInfo.getCommonAdverseReactions();
                }
                if (StringUtils.isBlank(drugInfo.getCommonAdverseReactions()) && StringUtils.isNotBlank(drugInfo.getAdverseReaction())) {
                    adverseReaction = drugInfo.getAdverseReaction();
                }

                if (StringUtils.isNotBlank(adverseReaction)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出中度不良反应内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.COMMON_ADVERSE_REACTIONS_PROMPT, adverseReaction, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "中度不良反应得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("mildAdverseReactionScore", score, "中度不良反应得分");
                    writer.write("mildAdverseReaction", content, "中度不良反应");
                    return Double.parseDouble(score);
                } else {
                    writer.write("mildAdverseReactionScore", "", "中度不良反应得分");
                    writer.write("mildAdverseReaction", "", "中度不良反应");
                    return 0.0;
                }
            });
            CompletableFuture<Double> serverAdverseReactionsFuture = scheduler.submit(43, () -> {
                String adverseReaction = "";
                if (StringUtils.isNotBlank(drugInfo.getSeriousAdverseRactions())) {
                    adverseReaction = "重度不良反应：" + drugInfo.getSeriousAdverseRactions();
                }
                if (StringUtils.isBlank(drugInfo.getSeriousAdverseRactions()) && StringUtils.isNotBlank(drugInfo.getAdverseReaction())) {
                    adverseReaction = drugInfo.getAdverseReaction();
                }

                if (StringUtils.isNotBlank(adverseReaction)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出重度不良反应内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.SERVER_ADVERSE_REACTIONS_PROMPT, adverseReaction, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "重度不良反应得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("severeAdverseReactionScore", score, "重度不良反应得分");
                    writer.write("severeAdverseReaction", content, "重度不良反应");
                    return Double.parseDouble(score);
                } else {
                    writer.write("severeAdverseReactionScore", "", "重度不良反应得分");
                    writer.write("severeAdverseReaction", "", "重度不良反应");
                    return 0.0;
                }
            });
            CompletableFuture<Double> threeOnePartFuture = CompletableFuture.allOf(
                    commonAdverseReactionsFuture, serverAdverseReactionsFuture
            ).thenApply(v -> {
                // 在这里可以安全地调用 join 来获取结果
                double commonAdverseReactionsScore = commonAdverseReactionsFuture.join();
                double serverAdverseReactionsScore = serverAdverseReactionsFuture.join();

                double adverseReactionsScore = commonAdverseReactionsScore + serverAdverseReactionsScore;
                writer.write("AdverseReactionScore", adverseReactionsScore, "不良反应总得分");
                return adverseReactionsScore;
            });
            
            CompletableFuture<Double> childrenFuture = scheduler.submit(42, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "儿童用药相关内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String childrenPrompt = PromptConstant.getPrompt(PromptConstant.CHILDREN_MEDICINE_PROMPT, drugInfoStr, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(childrenPrompt, JSONObject.class, "儿童用药得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("childrenMedicineScore", score, "儿童用药得分");
                    writer.write("childrenMedicine", content, "儿童用药");
                    return Double.parseDouble(score);
                } else {
                    writer.write("childrenMedicineScore", "", "儿童用药得分");
                    writer.write("childrenMedicine", "", "儿童用药");
                    return 0.0;
                }
            });
            CompletableFuture<Double> geriatricFuture = scheduler.submit(41, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出老年人用药相关内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String geriatricPrompt = PromptConstant.getPrompt(PromptConstant.GERIATRIC_MEDICINE_PROMPT, drugInfoStr, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(geriatricPrompt, JSONObject.class, "老年用药得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("geriatricMedicineScore", score, "老年用药得分");
                    writer.write("geriatricMedicine", content, "老年用药");
                    return Double.parseDouble(score);
                } else {
                    writer.write("geriatricMedicineScore", "", "老年用药得分");
                    writer.write("geriatricMedicine", "", "老年用药");
                    return 0.0;
                }
            });
            CompletableFuture<Double> pregnantWomenFuture = scheduler.submit(40, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("pregnantProcess", "妊娠期用药相关内容（请以 String 类型返回内容）");
                    resField.put("lactatingProcess", "哺乳期用药相关内容（请以 String 类型返回内容）");
                    resField.put("pregnantScore", "妊娠期用药分数（只能是阿拉伯数字组成）");
                    resField.put("lactatingScore", "哺乳期用药分数（只能是阿拉伯数字组成）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pregnantWomenPrompt = PromptConstant.getPrompt(PromptConstant.PREGNANTWOMEN_MEDICINE_PROMPT, drugInfoStr, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(pregnantWomenPrompt, JSONObject.class, "孕妇用药得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String pregnantScore = aiResult.getString("pregnantScore");
                    String lactatingScore = aiResult.getString("lactatingScore");
                    String pregnantProcess = aiResult.getString("pregnantProcess");
                    String lactatingProcess = aiResult.getString("lactatingProcess");

                    writer.write("pregnantWomenScore", pregnantScore, "妊娠期用药得分");
                    writer.write("pregnantWomen", pregnantProcess, "妊娠期用药");

                    writer.write("lactationScore", lactatingScore, "哺乳期用药得分");
                    writer.write("lactation", lactatingProcess, "哺乳期用药");
                    
                    double pregnantScoreValue = StringUtils.isNotBlank(pregnantScore) ? Double.parseDouble(pregnantScore) : 0.0;
                    double lactatingScoreValue = StringUtils.isNotBlank(lactatingScore) ? Double.parseDouble(lactatingScore) : 0.0;
                    return pregnantScoreValue + lactatingScoreValue;
                } else {
                    writer.write("pregnantWomenScore", "", "妊娠期用药得分");
                    writer.write("pregnantWomen", "", "妊娠期用药");

                    writer.write("lactationScore", "", "哺乳期用药得分");
                    writer.write("lactation", "", "哺乳期用药");
                    return 0.0;
                }
            });
            CompletableFuture<Double> liverFuture = scheduler.submit(39, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "肝功能用药相关内容（请以 String 类型返回内容），如果没有任何内容请返回空字符串");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String liverPrompt = PromptConstant.getPrompt(PromptConstant.LIVER_PROMPT_WEST, JSON.toJSONString(properties), drugInfoStr);
                    JSONObject aiResult = retryUtils.executeWithRetry(liverPrompt, JSONObject.class, "肝用药得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("liverScore", score, "肝用药得分");
                    writer.write("liver", content, "肝");
                    return Double.parseDouble(score);
                } else {
                    writer.write("liverScore", "", "肝用药得分");
                    writer.write("liver", "", "肝");
                    return 0.0;
                }
            });
            CompletableFuture<Double> renalFuture = scheduler.submit(38, () -> {
                String drugInfoStr = drugInfo.toString();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "肾功能用药相关内容（请以 String 类型返回内容），如果没有任何内容请返回空字符串");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.RENAL_PROMPT_EAST, JSON.toJSONString(properties), drugInfoStr);
                    JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "肾用药得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("renalScore", score, "肾用药得分");
                    writer.write("renal", content, "肾用药");
                    return Double.parseDouble(score);
                } else {
                    writer.write("renalScore", "", "肾用药得分");
                    writer.write("renal", "", "肾用药");
                    return 0.0;
                }
            });
            CompletableFuture<Double> threeTwoPartFuture = CompletableFuture.allOf(
                    childrenFuture, geriatricFuture, pregnantWomenFuture, liverFuture, renalFuture
            ).thenApply(v -> {
                double childrenScore = childrenFuture.join();
                double geriatricScore = geriatricFuture.join();
                double pregnantWomenScore = pregnantWomenFuture.join();
                double liverScore = liverFuture.join();
                double renalScore = renalFuture.join();
                
                double total = childrenScore + geriatricScore + pregnantWomenScore + liverScore + renalScore;
                writer.write("specialCrowdScore", total, "特殊人群总得分");
                return total;
            });
            
            // 药物相互作用所致不良反应
            CompletableFuture<Double> drugInteractionFuture = scheduler.submit(37, () -> {
                String drugInteraction = drugInfo.getDrugInteraction();

                if (StringUtils.isNotBlank(drugInteraction)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "药物相互作用所致不良反应相关内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String childrenPrompt = PromptConstant.getPrompt(PromptConstant.DRUG_INTERACTION_PROMPT, drugInteraction, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(childrenPrompt, JSONObject.class, "相互作用得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("drugInteractionScore", score, "相互作用得分");
                    writer.write("drugInteraction", content, "相互作用");
                    return Double.parseDouble(score);
                } else {
                    writer.write("drugInteractionScore", "", "相互作用得分");
                    writer.write("drugInteraction", "", "相互作用");
                    return 0.0;
                }
            });
            // 不良反应可逆性
            CompletableFuture<Double> adverseReactionReversibilityFuture = scheduler.submit(36, () -> {
                String commonAdverseReactions = drugInfo.getCommonAdverseReactions();
                String seriousAdverseRactions = drugInfo.getSeriousAdverseRactions();
                String adverse = commonAdverseReactions + seriousAdverseRactions;

                if (StringUtils.isNotBlank(adverse)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出不良反应可逆性相关内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String childrenPrompt = PromptConstant.getPrompt(PromptConstant.ADVERSE_REACTION_REVERSIBILITY_PROMPT, adverse, drugName, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(childrenPrompt, JSONObject.class, "不良反应可逆性得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("reversibleReactionScore", score, "不良反应可逆性得分");
                    writer.write("reversibleReaction", content, "不良反应可逆性");
                    return Double.parseDouble(score);
                } else {
                    writer.write("reversibleReactionScore", "", "不良反应可逆性得分");
                    writer.write("reversibleReaction", "", "不良反应可逆性");
                    return 0.0;
                }
            });
            CompletableFuture<Double> carcinogenicAndTeratogenicFuture = scheduler.submit(35, () -> {
                String drugInfoStr = drugInfo.toString();
//                String geneticsReproductionCarcinogenicity = drugInfo.getGeneticsReproductionCarcinogenicity();

                if (StringUtils.isNotBlank(drugInfoStr)) {
                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出致癌、致畸相关内容（请以 String 类型返回内容）");
                    resField.put("analysis", "打分，分析过程");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String childrenPrompt = PromptConstant.getPrompt(PromptConstant.CARCINOGENIC_TERATOGENIC_PROMPT, drugInfoStr, drugName, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(childrenPrompt, JSONObject.class, "致癌、致畸得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String score = aiResult.getString("score");
                    String content = aiResult.getString("content");

                    writer.write("genicityAdverseReactionScore", score, "致癌、致畸得分");
                    writer.write("genicityAdverseReaction", content, "致癌、致畸");
                    return Double.parseDouble(score);
                } else {
                    writer.write("genicityAdverseReactionScore", "", "致癌、致畸得分");
                    writer.write("genicityAdverseReaction", "", "致癌、致畸");
                    return 0.0;
                }
            });
            CompletableFuture<Double> pharmacovigilanceFuture = scheduler.submit(34, () -> {
                StringBuilder pharmacovigilanceBuilder = new StringBuilder();

                // 处理FDA黑框警告
                if (StringUtils.isNotBlank(drugInfo.getBlackBoxWaringOfFDA())) {
                    pharmacovigilanceBuilder.append("FDA黑框警告：\n").append(drugInfo.getBlackBoxWaringOfFDA()).append("\n");
                }

                // 收集所有药物名称（主药名+同义词）
                List<String> allDrugs = new ArrayList<>();
                allDrugs.add(drugInfo.getDrugZh());
                if (drugInfo.getDrugSynonymZh() != null) {
                    allDrugs.addAll(drugInfo.getDrugSynonymZh());
                }
                allDrugs = allDrugs.stream().filter(StringUtils::isNotEmpty).collect(Collectors.toList());

                
                Criteria synopsisCriteria = new Criteria().orOperator(allDrugs.stream()
                        .map(drug -> Criteria.where("synopsis")
                                .regex(Pattern.compile(".*" + Pattern.quote(drug) + ".*", Pattern.CASE_INSENSITIVE))).toArray(Criteria[]::new));
                Query synopsisQuery = new Query(synopsisCriteria)
                        .with(Sort.by(Sort.Direction.DESC, "data_time"));
                List<JSONObject> synopsisResults = mongoTemplate.find(synopsisQuery, JSONObject.class, "pharmacovigilance");

                Criteria titleCriteria = new Criteria().orOperator(allDrugs.stream()
                        .map(drug -> Criteria.where("title")
                                .regex(Pattern.compile(".*" + Pattern.quote(drug) + ".*", Pattern.CASE_INSENSITIVE))).toArray(Criteria[]::new));
                Query titleQuery = new Query(titleCriteria)
                        .with(Sort.by(Sort.Direction.DESC, "data_time"));
                List<JSONObject> titleResults = mongoTemplate.find(titleQuery, JSONObject.class, "pharmacovigilance");

                // 处理查询结果
                if (!synopsisResults.isEmpty() || !titleResults.isEmpty()) {
                    pharmacovigilanceBuilder.append("药物警戒：\n");

                    AtomicInteger counter = new AtomicInteger(0);

                    // 如果摘要搜索有结果
                    if (!synopsisResults.isEmpty()) {
                        for (JSONObject synopsisObj : synopsisResults) {
                            // 从摘要中提取包含药物名称的相关内容
                            String content = "";
                            JSONArray synopsis = synopsisObj.getJSONArray("synopsis");
                            if (synopsis != null) {
                                for (String contentItem : synopsis.toJavaList(String.class)) {
                                    for (String drug : allDrugs) {
                                        if (StringUtils.containsIgnoreCase(contentItem, drug)) {
                                            content = contentItem;
                                            break;
                                        }
                                    }
                                    if (!content.isEmpty()) {
                                        break;
                                    }
                                }
                            }

                            String circleNumber = String.valueOf((char) (0x2460 + counter.getAndIncrement()));
                            String title = synopsisObj.getString("title");
                            String dataTime = synopsisObj.getString("data_time");
                            String titleUrl = synopsisObj.getString("title_url");

                            pharmacovigilanceBuilder.append(String.format("%s%s：%s(发布时间：%s)\n",
                                            circleNumber, title, content, dataTime))
                                    .append("原文链接：").append(titleUrl).append("\n");
                        }
                    } else {
                        // 如果标题搜索有结果
                        for (JSONObject titleObj : titleResults) {
                            String circleNumber = String.valueOf((char) (0x2460 + counter.getAndIncrement()));
                            String title = titleObj.getString("title");
                            String dataTime = titleObj.getString("data_time");
                            String titleUrl = titleObj.getString("title_url");

                            pharmacovigilanceBuilder.append(String.format("%s%s(发布时间：%s)\n",
                                            circleNumber, title, dataTime))
                                    .append("原文链接：").append(titleUrl).append("\n");
                        }
                    }
                }

                // 如果没有找到相关信息
                String pharmacovigilanceBuilderStr = pharmacovigilanceBuilder.toString();
                if (StringUtils.isBlank(pharmacovigilanceBuilderStr)) {
                    pharmacovigilanceBuilder.append("暂未找到用药警示相关信息");
                    writer.write("alertAdverseReactionScore", 1, "药物警戒得分");
                    writer.write("alertAdverseReaction", "暂未找到用药警示相关信息。", "药物警戒");
                    return 0.0;
                } else {
                    writer.write("alertAdverseReactionScore", 0, "药物警戒得分");
                    writer.write("alertAdverseReaction", pharmacovigilanceBuilderStr, "药物警戒");
                    return 1.0;
                }                
            });
            CompletableFuture<Double> threeThreePartFuture = CompletableFuture.allOf(
                    adverseReactionReversibilityFuture, carcinogenicAndTeratogenicFuture, pharmacovigilanceFuture
            ).thenApply(v -> {
                double adverseReactionReversibilityScore = adverseReactionReversibilityFuture.join();
                double carcinogenicAndTeratogenicScore = carcinogenicAndTeratogenicFuture.join();
                double pharmacovigilanceScore = pharmacovigilanceFuture.join();

                double total = adverseReactionReversibilityScore + carcinogenicAndTeratogenicScore + pharmacovigilanceScore;
                writer.write("otherSafetyScore", total, "其他总得分");
                return total;
            });
            CompletableFuture<Double> threePartFuture = CompletableFuture.allOf(
                    threeOnePartFuture, threeTwoPartFuture, threeThreePartFuture, drugInteractionFuture
            ).thenApply(v -> {
                // 在这里可以安全地调用 join 来获取结果
                double threeOnePartScore = threeOnePartFuture.join();
                double threeTwoPartScore = threeTwoPartFuture.join();
                double threeThreePartScore = threeThreePartFuture.join();
                double drugInteractionScore = drugInteractionFuture.join();

                double total = threeOnePartScore + threeTwoPartScore + threeThreePartScore + drugInteractionScore;
                writer.write("safetyScore", total, "第三模块总得分");
                return total;
            });

            // 第四部分
            CompletableFuture<Double> fiveOtherFuture = scheduler.submit(33, () -> {
                float otherVscore = 0f;

                // 国家医保
                float isInsuranceScore = 1.00F;
                String medicalInsurance = drugInfo.getMedicalInsurance();
                boolean isInsurance = StringUtils.isNotBlank(medicalInsurance);
                boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo.getPaymentScope());

                if (isInsurance) {
                    if ("甲".equals(medicalInsurance)) {
                        isInsuranceScore = paymentScopeStatus ? 2.50F : 3.00F;
                    } else {
                        isInsuranceScore = paymentScopeStatus ? 1.50F : 2.00F;
                    }
                }
               
                String isInsuranceStr;
                if (isInsurance) {
                    StringBuilder sb = new StringBuilder("已纳入医保");
                    if (StringUtils.isNotBlank(drugInfo.getMedicalInsurance())) {
                        sb.append("，").append(drugInfo.getMedicalInsurance());
                    }
                    sb.append("，");
                    sb.append(paymentScopeStatus ? drugInfo.getPaymentScope() : "无支付限制");
                    isInsuranceStr = sb.toString();
                } else {
                    isInsuranceStr = "未纳入医保";
                }
                
                otherVscore += isInsuranceScore;

                writer.write("isInsuranceScore", isInsuranceScore, "医保得分");
                writer.write("isInsurance", isInsuranceStr, "医保");
                

                //  国家基本药物目录纳入情况模块
                boolean isBase = "是".equals(drugInfo.getEssentialMedicines());
                String essentialType = drugInfo.getEssentialType();
                int typeScore = StringUtils.isNotBlank(essentialType) ? 1 : 0;
                
                otherVscore = isBase ? otherVscore + 3 - typeScore : otherVscore + 1;

                writer.write("isBaseScore", isBase ? (3 - typeScore) : 1, "国家基本药物得分");
                writer.write("isBase", isBase ? "已被纳入国家基本药物目录，" + (StringUtils.isNotBlank(essentialType) ? "有△要求" : "无△要求") : "未纳入国家基本药物目录", "国家基本药物");
                
                // 国家集中采购情况模块
                boolean isConcentrate = !("本品非集采药品。".equals(drugInfo.getDrugCollection()) ||
                        drugInfo.getDrugCollection() != null && drugInfo.getDrugCollection().contains("不属于"));

                if (isConcentrate) {
                    otherVscore++;
                }

                int concentrateScore = isConcentrate ? 1 : 0;
                String concentrateText = isConcentrate ? "已纳入国家集中采购" : "未纳入国家集中采购";

                writer.write("isConcentrateScore", concentrateScore, "集采得分");
                writer.write("isConcentrate", concentrateText, "集采");
                
                // 药品情况模块
                String drugSituationString = "未知";
                String originalDrug = drugInfo.getOriginalDrug();
                String referenceDrug = drugInfo.getReferenceDrug();
                String consistencyDrug = drugInfo.getConsistencyDrug();

                String process;
                double drugSituationScore;

                if (CommonConstants.YES.equals(originalDrug)) {
                    process = "本药品为原研药品。";
                    // 检查是否同时是参比药品
                    if (StringUtils.isNotEmpty(referenceDrug) && "本品为仿制药参比药品。".equals(referenceDrug)) {
                        process += "\n" + referenceDrug;
                    }
                    drugSituationScore = 1;
                } else if ("本品为仿制药参比药品。".equals(referenceDrug)) {
                    process = "本药品为仿制药参比药品。";
                    drugSituationScore = 1;
                } else if (CommonConstants.YES.equals(consistencyDrug)) {
                    process = "本药品为一致性评价药品。";
                    drugSituationScore = 0.5;
                } else {
                    process = "本药品为非一致性评价药品。";
                    drugSituationScore = 0;
                }

                try {
                    otherVscore += (float) drugSituationScore;
                } catch (Exception e) {
                    log.error("计算药品情况分数时发生错误", e);
                    otherVscore += 0;
                }

                if (StringUtils.isNotBlank(process)) {
                    writer.write("guideDrugSituationScore", (float) drugSituationScore, "原研/参比/一致性评价");
                    writer.write("guideDrugSituation", process, "原研/参比/一致性评价");
                } else {
                    writer.write("guideDrugSituationScore", 0, "原研/参比/一致性评价");
                    writer.write("guideDrugSituation", "未知", "原研/参比/一致性评价");
                }

                // 生产企业情况模块
                String manufacturer = drugInfo.getManufacturer();
                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("analysis", "打分，分析过程");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.MANUFACTURING_ENTERPRISE_PROMPT, manufacturer, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "生产企业得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String score = aiResult.getString("score");
                String content = aiResult.getString("analysis");
                
                if (StringUtils.isNotBlank(process)) {
                    writer.write("guideEnterpriseScore", score, "生产企业得分");
                    writer.write("guideEnterprise", content, "生产企业");
                    otherVscore += Float.parseFloat(score);
                } else {
                    writer.write("guideEnterpriseScore", 0, "生产企业得分");
                    writer.write("guideEnterprise", "未知", "生产企业");
                }

               return (double)otherVscore;
            });
            CompletableFuture<Double> globalUsageFuture = scheduler.submit(32, () -> {
                //全球使用情况
                String globalUsage = drugInfo.getGlobalUsage();
                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "上市相关信息");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.GLOBAL_USAGE_PROMPT, globalUsage, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "中度不良反应得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String score = aiResult.getString("score");
                String content = aiResult.getString("content");
                writer.write("guideCountryScore1", score, "上市情况得分");
                writer.write("guideCountry1", content, "上市情况");
               return Double.parseDouble(score);
            });
            CompletableFuture<Double> salesAnalysisFuture = scheduler.submit(31, () -> {
                //全球使用情况
                String globalUsage = drugInfo.getGlobalUsage();
                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "销售情况相关信息");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String pharmacologyPrompt = PromptConstant.getPrompt(PromptConstant.SALES_ANALYSIS_PROMPT, globalUsage, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(pharmacologyPrompt, JSONObject.class, "中度不良反应得分计算", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String score = aiResult.getString("score");
                String content = aiResult.getString("content");
                writer.write("guideCountryScore2", score, "销售情况得分");
                writer.write("guideCountry2", content, "销售情况");
                return Double.parseDouble(score);
            });
            CompletableFuture<Double> fivePartFuture = CompletableFuture.allOf(
                    fiveOtherFuture, globalUsageFuture, salesAnalysisFuture
            ).thenApply(v -> {
                double fiveOtherPartScore = fiveOtherFuture.join();
                double globalUsageScore = globalUsageFuture.join();
                double salesAnalysisScore = salesAnalysisFuture.join();

                double globalUsageMaxScore = Math.max(globalUsageScore, salesAnalysisScore);
                writer.write("guideCountryScore", globalUsageMaxScore, "全球使用情况得分");

                double total = fiveOtherPartScore + globalUsageMaxScore;
                writer.write("otherScore", total, "第五模块总得分");
                return total;
            });

            // 总分计算
            CompletableFuture<Void> allPartFuture = CompletableFuture.allOf(
                    onePartFuture, 
                    twoPartFuture,
                    threePartFuture,
                    fivePartFuture
            );

            // 🔥 等待所有任务完成
            try {
                allPartFuture.get(300, TimeUnit.SECONDS);
                log.info("报告所有模块完成，花费时间{}", new Date().getTime() - concurrenceData.getTime());
            } catch (Exception e) {
                log.error("任务执行异常", e);
            } finally {
                writer.write("end", drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer(),"end");
                // 等待最多5秒让所有结果输出，然后停止调度器
                writer.waitForCompletionAndStop(100, TimeUnit.SECONDS);
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    log.error("所有任务完成，等待 5秒 处执行异常", e);
                }
                scheduler.shutdown();
            }

            JSONObject jsonObject = new JSONObject();
            jsonObject.put("title", drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer()+"-"+disease);
            jsonObject.put("info",stringBuilder);
            mongoTemplate.insert(jsonObject,"evaluation_wm_cache");

//            if ("1".equals(isDev)){
//                ChangeMongoUtil.mongo.insert(jsonObject,"evaluation_wm_cache");
//            }else {
//                mongoTemplate.insert(jsonObject,"evaluation_wm_cache");
//            }

            String uuid = UUID.randomUUID().toString();

            result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
            result.put("id", id);
            result.put("_id", id);
            result.put("drugName", drugName);
            result.put("disease", disease);
            StringBuilder drugInfoSB = new StringBuilder();
            if (StringUtils.isNotBlank(drugName)) {
                drugInfoSB.append(drugName).append("-");
            }
            if (StringUtils.isNotBlank(drugInfo.getSpecifications())) {
                drugInfoSB.append(drugInfo.getSpecifications()).append("-");
            }
            if (StringUtils.isNotBlank(enterpriseName)) {
                drugInfoSB.append(enterpriseName);
            }
            result.put("drugInfo", drugInfoSB.toString());

            JSONObject variousScore = new JSONObject();
            redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, variousScore, 1, TimeUnit.HOURS);

            log.info(result.toJSONString());
            result.put("content", stringBuilder);
            log.info("剩余代码执行花费时长{}", System.currentTimeMillis() - begin);
        }
        return result;
    }
    private void assembleGuide(String guideId, List<JSONObject> guideList, String medicine, String disease, List<String> drugSynonym, List<String> diseaseSynonym, JSONObject guideInfo, GuideIndex guideIndex, AtomicInteger successCount, AtomicBoolean shouldStop) {
        // 早期检查，如果已经达到限制就直接返回
        if (shouldStop.get() || successCount.get() >= 5) {
            return;
        }

        // 获取指南信息
        List<String> keywords = Arrays.asList("NCCN", "ASCO", "ESMO", "NICE", "WHO", "JSGO", "CCO");
        CharSequence[] searchSeqs = keywords.toArray(new CharSequence[0]);
        String zdz = guideIndex.getZdz();
        guideInfo.put("zdz", zdz);
        String fbdate = guideIndex.getFbdate();
        guideInfo.put("fbdate", fbdate);
        String title = guideIndex.getTitle();

        // 权威指南标题必须包含疾病
        if (StringUtils.containsAny(zdz, searchSeqs) && !checkFullWordContain(title, diseaseSynonym)) {
            return;
        }

        // 获取指南内容（优先使用 pdf_txt，如果为空则使用 block）
        String guideContent = guideIndex.getPdf_txt();
        if (StringUtils.isEmpty(guideContent)) {
            guideContent = guideIndex.getBlock();
        }
        if (StringUtils.isEmpty(guideContent)) {
            return; // 没有内容，直接返回
        }

        // 截断过长内容（避免AI处理超长文本）
        if (guideContent.length() > 20000) {
            guideContent = guideContent.substring(0, 20000);
        }

        // 检查内容是否同时包含药品和疾病
        boolean containsDrug = checkFullWordContain(guideContent, drugSynonym);
        boolean containsDisease = checkFullWordContain(guideContent, diseaseSynonym);

        // 必须同时包含药品和疾病（或者是权威指南只需包含药品）
        if (containsDrug && containsDisease) {
            // 同时包含药品和疾病，使用 type=1 的 prompt
            sumUpBlock(guideContent, medicine, disease, guideList, guideInfo, 1, successCount, shouldStop);
        } else if (StringUtils.containsAny(zdz, searchSeqs) && containsDrug) {
            // 权威指南只包含药品，使用 type=4 的 prompt
            sumUpBlock(guideContent, medicine, disease, guideList, guideInfo, 4, successCount, shouldStop);
        }
        // 否则不处理该指南
    }
    private void sumUpBlock(String block, String medicine, String disease, List<JSONObject> guideList, JSONObject guideInfo, int type, AtomicInteger successCount, AtomicBoolean shouldStop) {
        // 早期检查，如果已经达到限制就直接返回
        if (shouldStop.get() || successCount.get() >= 5) {
            return;
        }

        if(StrUtil.isNotBlank(block)) {

            String question_1;
            switch (type) {                case 1:
                question_1 = String.format(
                        "你是一名临床药师，请基于输入的【临床指南原文】，判断材料是否与“目标药品治疗目标疾病”相关，并抽提总结相关内容。\n" +
                                "\n" +
                                "【判断原则】\n" +
                                "\n" +
                                "1. relevance=true 需同时满足：\n" +
                                "\n" +
                                "   * 指南原文提到目标药品，或提到目标药品所属的药品分类；\n" +
                                "   * 指南原文提到目标疾病、疾病亚型、适用人群或治疗场景；\n" +
                                "   * 指南原文存在治疗相关内容，如推荐使用、用于治疗、一线、首选、初始治疗、二线、替代、联合治疗、特殊人群使用、不推荐、禁忌、慎用、证据不足等。\n" +
                                "\n" +
                                "2. 若指南只提到药品分类，未直接提到目标药品，允许你基于自身医学知识判断目标药品是否属于该分类。若能够确认属于该分类，且该分类在指南中与目标疾病治疗相关，则 relevance=true。\n" +
                                "\n" +
                                "3. 你只能用自身医学知识判断“目标药品是否属于某药品分类”，不得用自身知识补充指南中没有写明的治疗推荐、治疗线别、适用人群、疾病阶段、限制条件、证据等级或推荐等级。\n" +
                                "\n" +
                                "4. 以下情况 relevance=false：\n" +
                                "\n" +
                                "   * 指南未提到目标药品，也未提到可覆盖目标药品的药品分类；\n" +
                                "   * 指南未提到目标疾病或相关治疗场景；\n" +
                                "   * 仅提到药品/药品分类，但未说明其与目标疾病治疗有关；\n" +
                                "   * 仅提到疾病，但未涉及目标药品或其所属分类；\n" +
                                "   * 仅为诊断、检查、流行病学、护理、随访等内容，无药物治疗信息；\n" +
                                "   * 无法确认目标药品是否属于指南中提到的药品分类。\n" +
                                "\n" +
                                "【总结要求】\n" +
                                "\n" +
                                "当 relevance=true 时，总结：\n" +
                                "\n" +
                                "* 目标药品或其所属分类用于目标疾病的相关内容；\n" +
                                "* 指南中的治疗定位，如一线、首选、初始治疗、二线、替代、联合、特殊人群使用、不推荐、禁忌、证据不足或未明确治疗线别；\n" +
                                "* 适用人群、疾病阶段、使用条件或限制条件；\n" +
                                "* 关键原文依据。\n" +
                                "\n" +
                                "当 relevance=false 时，说明未发现目标药品治疗目标疾病的明确关联证据。\n" +
                                "\n" +
                                "【输出要求】\n" +
                                "\n" +
                                "必须只输出标准 JSON，不要输出 Markdown，不要输出多余字段。\n" +
                                "\n" +
                                "若 relevance=true，输出：\n" +
                                "\n" +
                                "{\n" +
                                "\"relevance\": true,\n" +
                                "\"summary\": \"≤300字，基于指南原文总结目标药品或其所属分类治疗目标疾病的相关内容\",\n" +
                                "\"key_evidence\": [\n" +
                                "\"关键原文依据1\",\n" +
                                "\"关键原文依据2\"\n" +
                                "],\n" +
                                "\"treatment_position\": \"一线/首选/初始治疗/二线/替代/后线/联合治疗/特殊人群使用/不推荐/禁忌/证据不足/未明确治疗线别\"\n" +
                                "}\n" +
                                "\n" +
                                "若 relevance=false，输出：\n" +
                                "\n" +
                                "{\n" +
                                "\"relevance\": false,\n" +
                                "\"summary\": \"材料中未发现目标药品治疗目标疾病的明确关联证据\",\n" +
                                "\"key_evidence\": [],\n" +
                                "\"treatment_position\": \"无相关治疗定位\"\n" +
                                "}\n" +
                                "\n" +
                                "【输入数据】\n" +
                                "\n" +
                                "* 目标疾病：{%s}\n" +
                                "* 目标药品：{%s}\n" +
                                "* 临床指南原文：'''{%s}'''",
                        medicine, disease, block
                );
                break;

                case 2:
                    question_1 = String.format(
                            "请作为专业医学内容分析师，执行以下任务：\n" +
                                    "1. 根据用户提供的资料，生成针对%s的总结报告\n" +
                                    "2. 判断原始资料与疾病的相关性\n" +
                                    "3. 以严格JSON格式返回结果，包含以下字段：\n" +
                                    "   - summary：总结文本，控制在400字以内，直接切入主题\n" +
                                    "   - relevance：布尔值，资料必须同时包含药品和疾病的具体关联证据才为true\n" +
                                    "\n" +
                                    "要求：\n" +
                                    "- 保持医学专业性同时避免术语堆砌\n" +
                                    "- 仅当资料明确包含药品和疾病的直接关联数据（如临床试验、药理机制等）时，relevance才为true\n" +
                                    "- 彻底排除任何推测性内容和格式标签\n" +
                                    "- 英文资料必须转化为中文表述\n" +
                                    "\n" +
                                    "资料内容：%s",
                            disease, block
                    );
                    break;
                case 3:
                    question_1 = String.format(
                            "请作为专业医学内容分析师，执行以下任务：\n" +
                                    "1. 根据用户提供的资料，生成针对%s的总结报告\n" +
                                    "2. 判断原始资料与药品的相关性\n" +
                                    "3. 以严格JSON格式返回结果，包含以下字段：\n" +
                                    "   - summary：总结文本，控制在400字以内，直接切入主题\n" +
                                    "   - relevance：布尔值，资料必须同时包含药品和疾病的具体关联证据才为true\n" +
                                    "\n" +
                                    "要求：\n" +
                                    "- 保持医学专业性同时避免术语堆砌\n" +
                                    "- 仅当资料明确包含药品和疾病的直接关联数据（如临床试验、药理机制等）时，relevance才为true\n" +
                                    "- 彻底排除任何推测性内容和格式标签\n" +
                                    "- 英文资料必须转化为中文表述\n" +
                                    "\n" +
                                    "资料内容：%s",
                            medicine, block
                    );
                    break;
                case 4:
                    question_1 = String.format(
                            "请作为专业医学内容分析师，执行以下任务：\n" +
                                    "1. 根据用户提供的资料，针对指南标题 %s，结合资料内容，生成针对%s的总结报告\n" +
                                    "2. 判断原始资料与药品的相关性\n" +
                                    "3. 以严格JSON格式返回结果，包含以下字段：\n" +
                                    "   - summary：总结文本，控制在400字以内，直接切入主题\n" +
                                    "   - relevance：布尔值，资料必须同时包含药品和疾病的具体关联证据才为true\n" +
                                    "\n" +
                                    "要求：\n" +
                                    "- 保持医学专业性同时避免术语堆砌\n" +
                                    "- 仅当资料明确包含药品和疾病的直接关联数据（如临床试验、药理机制等）时，relevance才为true\n" +
                                    "- 彻底排除任何推测性内容和格式标签\n" +
                                    "- 英文资料必须转化为中文表述\n" +
                                    "\n" +
                                    "资料内容：%s",
                            guideInfo.getString("title"), disease, block
                    );
                    break;
                default:
                    question_1 = String.format(
                            "请作为专业医学内容分析师，执行以下任务：\n" +
                                    "1. 根据用户提供的资料，生成一份总结报告\n" +
                                    "2. 以严格JSON格式返回结果，包含以下字段：\n" +
                                    "   - summary：总结文本，控制在400字以内，直接切入主题\n" +
                                    "   - relevance：布尔值，资料必须同时包含药品和疾病的具体关联证据才为true\n" +
                                    "\n" +
                                    "要求：\n" +
                                    "- 保持医学专业性同时避免术语堆砌\n" +
                                    "- 仅当资料明确包含药品和疾病的直接关联数据（如临床试验、药理机制等）时，relevance才为true\n" +
                                    "- 彻底排除任何推测性内容和格式标签\n" +
                                    "- 英文资料必须转化为中文表述\n" +
                                    "\n" +
                                    "资料内容：%s",
                            block
                    );
                    break;
            }

            try {
                String summary = AIRequestUtils.dsNonStream(question_1, "deepseek-v4-pro");
//                String summary = retryUtils.executeWithRetry(question_1, String.class, "指南总结", PriorityConstants.PRIORITY_CRITICAL, null);
                log.info("总结内容为 {}", summary);
                if (StrUtil.isNotBlank(summary)) {
                    try {
                        int start = summary.indexOf('{');
                        int end = summary.lastIndexOf('}');
                        Gson gson = new Gson();
                        Type guideSummary = new TypeToken<JSONObject>(){}.getType();
                        JSONObject result = gson.fromJson(summary.substring(start, end + 1), guideSummary);
                        block = result.getString("summary");
                        Boolean relevance = result.getBoolean("relevance");
                        if (relevance) {
                            block = wiffOfContent(block, "\n\n", "\n");
                            guideInfo.put("block", block);
//                            guideList.add(guideInfo);
                            log.info("指南纳入，当前数量为{}", guideList.size());
                        }
                        Thread.sleep(1000);
                    } catch (Exception e) {
                        log.error("总结guide block 出现问题{}", e.getMessage(), e);
                    }
                }

                String prompt = PromptConstant.getPrompt(PromptConstant.GUIDE_CORRELATION_PROMPT, medicine, disease, guideInfo.getString("id"), guideInfo.getString("block"), medicine, disease);
                JSONObject correlation = retryUtils.executeWithRetry(prompt, JSONObject.class, "指南相关性判断", PriorityConstants.PRIORITY_CRITICAL, null);
                String relevance = correlation.getString("relevance");
                if ("true".equals(relevance)) {
                    String prompt1 = PromptConstant.getPrompt(PromptConstant.GUIDE_RATING_PROMPT, guideInfo.getString("id"), guideInfo.getString("title"), guideInfo.getString("zdz"), guideInfo.getString("block"), guideInfo.getString("fbdate"));
                    JSONObject rating = retryUtils.executeWithRetry(prompt1, JSONObject.class, "指南相关性判断", PriorityConstants.PRIORITY_CRITICAL, null);
                    String score = rating.getString(guideInfo.getString("id"));
                    guideInfo.put("score", score);

                    // 使用同步块确保线程安全
                    synchronized (guideList) {
                        // 双重检查，确保不会超过限制
                        if (successCount.get() < 5 && !shouldStop.get()) {
                            guideList.add(guideInfo);
                            int currentCount = successCount.incrementAndGet();
                            if (currentCount >= 5) {
                                shouldStop.set(true);
                                log.info("已达到指南数量限制(5个)，停止处理更多指南");
                            }
                        }
                    }
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
    }
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }


    
    @Override
    public Object guidePanelTr(String drugId, String id, String userName, HttpServletResponse response) {
        //获得所有信息
        DrugInfoNew drugInfo = drugInfoUtil.getDrugInfo(drugId, null);
       
        TrInheritanceEvaluationDto trInheritanceEvaluationDto = new TrInheritanceEvaluationDto();
        TrClinicalEvaluationDto trClinicalEvaluationDto = new TrClinicalEvaluationDto();
        TrSafetyEvaluationDto trSafetyEvaluationDto = new TrSafetyEvaluationDto();
        TrTechnologyEvaluationDto trPolicyEvaluationDto = new TrTechnologyEvaluationDto();
        TrMarketEvaluationDto trMarketEvaluationDto = new TrMarketEvaluationDto();

        String title = drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer();
        List<JSONObject> objects  = mongoTemplate.find(new Query(Criteria.where("title").is(title)), JSONObject.class, "evaluation_tr_cache");
//        if (CollUtil.isNotEmpty(objects)) {
//            JSONObject jsonObject1 = objects.get(0);
//            JSONArray info = jsonObject1.getJSONArray("info");
//            for (CacheDto jsonObject : info.toJavaList(CacheDto.class)) {
//                writeTrCache(jsonObject, response);
//            }
//            return null;
//        }

        log.info("用户{}, 中成药课题{}", userName, drugInfo.getDrugName());
        PriorityAwareAsyncScheduler scheduler = new PriorityAwareAsyncScheduler(3);
        List<CacheDto> cacheDtos = new ArrayList<>();
        OrderedSSEWriter writer = new OrderedSSEWriter(Constants.REPORT_FIELDS_LIST, response, cacheDtos);
        writer.write("start", drugInfo.getDrugName(),"begin");
        Date concurrenceData = new Date();

        String register = drugInfo.getRegister();
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("register").is(register)), JSONObject.class, "evaluation_tra_form");

        // 第一部分
        CompletableFuture<Double> recipeSourceFuture = scheduler.submit(50, () -> {
            String drugName = drugInfo.getDrugName();
            
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

            if (StringUtils.isNotBlank(recipeSource)) {
                writer.write("recipeSourceScore", score, "组方来源得分");
                writer.write("recipeSourceContent", recipeSource, "组方来源内容");
            } else {
                if (StringUtils.isNotBlank(drugInfo.getIngredient())) {
                    recipeSource = "药品成分：" + drugInfo.getIngredient();

                    Map<String, String> resField = new HashMap<>();
                    resField.put("score", "分数（只能是阿拉伯数字组成）");
                    resField.put("content", "请提取出关于组方来源相关内容");
                    JSONObject properties = new JSONObject();
                    properties.putAll(resField);
                    String recipeSourcePrompt = PromptConstant.getPrompt(PromptConstant.RECIPE_SOURCE_PROMPT, drugName, recipeSource, JSON.toJSONString(properties));
                    JSONObject aiResult = retryUtils.executeWithRetry(recipeSourcePrompt, JSONObject.class, "组方来源模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                    String content = aiResult.getString("content");
                    score = aiResult.getString("score");
                    recipeSource = content;
                    writer.write("recipeSourceScore", score, "组方来源得分");
                    writer.write("recipeSourceContent", recipeSource, "组方来源内容");
                }  else {
                    score = "0.0";
                    writer.write("recipeSourceScore", "", "组方来源得分");
                    writer.write("recipeSourceContent", "", "组方来源内容");
                }
            }
            
            trInheritanceEvaluationDto.setRecipeSourceScore(extractLastNumber(score));
            trInheritanceEvaluationDto.setRecipeSourceContent(recipeSource);

            return Double.parseDouble(score);
        });
        CompletableFuture<Double> theoreticalFuture = scheduler.submit(49, () -> {
            String drugCategory = drugInfo.getDrugCategory();

            if ("中成药".equals(drugCategory)) {
                writer.write("theoryGuidanceScore", 2.0, "中医药理论指导分数");
                writer.write("theoryGuidanceContent", "基于中医药理论指导开发", "中医药理论指导");
                trInheritanceEvaluationDto.setTheoryGuidanceScore(2.0);
            } else {
                writer.write("theoryGuidanceScore", 0.0, "中医药理论指导分数");
                writer.write("theoryGuidanceContent", "非中医药理论指导开发", "中医药理论指导");
                trInheritanceEvaluationDto.setTheoryGuidanceScore(0.0);
            }

            return trInheritanceEvaluationDto.getTheoryGuidanceScore();
        });
        CompletableFuture<Double> oneOnePartFuture = CompletableFuture.allOf(
                recipeSourceFuture, theoreticalFuture
        ).thenApply(v -> {
            String drugName = drugInfo.getDrugName();
            String ingredient = drugInfo.getIngredient();

            Map<String, String> resCusField = new HashMap<>();
            resCusField.put("number", "判定结果（数字）");
            JSONObject properties = new JSONObject();
            properties.putAll(resCusField);
            String recipeSourcePrompt = PromptConstant.getPrompt(PromptConstant.THEORY_SUPPORT_PROMPT_PRE, drugName, ingredient, JSON.toJSONString(properties));
            JSONObject aiResult = retryUtils.executeWithRetry(recipeSourcePrompt, JSONObject.class, "理论支撑模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
            Integer number = aiResult.getInteger("number");
            if (number != 1 && number != 2) {
                properties = new JSONObject();
                resCusField = new HashMap<>();
                resCusField.put("content", "请给出君药、臣药、佐药、使药是什么（有明确依据才填写，无则省略字段），发挥的作用是什么？（请注意，内容的开始部分不用过多赘述‘我是一名xxx等信息’，直接显示内容即可。）");
                resCusField.put("reason", "详细说明分析过程和依据，若无足够信息说明原因");
                properties.putAll(resCusField);
                if (StringUtils.isBlank(ingredient)) ingredient = "【注意：该药品成分信息未提供，需基于药品名称和常规知识进行分析】";

                String recipeSourcePromptNext = PromptConstant.getPrompt(PromptConstant.THEORY_SUPPORT_PROMPT_NEXT, JSON.toJSONString(properties), drugName, ingredient);
                aiResult = retryUtils.executeWithRetry(recipeSourcePromptNext, JSONObject.class, "理论支持-君臣佐使配伍", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                writer.write("theoryCombinationScore", "2.0", "理论支持-君臣佐使配伍得分");
                writer.write("theoryCombinationContent", aiResult.getString("content"), "理论支持-君臣佐使配伍内容");
                trInheritanceEvaluationDto.setTheoryCombinationScore(2.0);
                trInheritanceEvaluationDto.setTheoryCombinationContent(aiResult.getString("content"));
            } else {
                writer.write("theoryCombinationScore", "0.0", "理论支持-君臣佐使配伍得分");
                writer.write("theoryCombinationContent", "无法遵循中医药的君臣佐使配伍原则", "理论支持-君臣佐使配伍内容");
                trInheritanceEvaluationDto.setTheoryCombinationScore(0.0);
                trInheritanceEvaluationDto.setTheoryCombinationContent("无法遵循中医药的君臣佐使配伍原则");
            }

            if (number == 2) {
                writer.write("theoryPathogenesisScore", "0.0", "理论支持-药性、归经与治疗目标得分");
                writer.write("theoryPathogenesisContent", "君臣药的药性、归经与治疗目标不相符", "理论支持-药性、归经与治疗目标");

                writer.write("theoryPotScore", "0.0", "理论支持-炮制品是否与治疗目标相符得分");
                writer.write("theoryPotContent", "君臣药的炮制品选择与治疗目标不相符", "理论支持-炮制品是否与治疗目标相符");

                trInheritanceEvaluationDto.setTheoryPathogenesisScore(0.0);
                trInheritanceEvaluationDto.setTheoryPotScore(0.0);
            } else {
                writer.write("theoryPathogenesisScore", "1.0", "理论支持-药性、归经与治疗目标得分");
                writer.write("theoryPathogenesisContent", "君臣药的药性、归经与治疗目标相符", "理论支持-药性、归经与治疗目标");

                writer.write("theoryPotScore", "1.0", "理论支持-炮制品是否与治疗目标相符得分");
                writer.write("theoryPotContent", "君臣药的炮制品选择与治疗目标相符", "理论支持-炮制品是否与治疗目标相符");

                trInheritanceEvaluationDto.setTheoryPathogenesisScore(1.0);
                trInheritanceEvaluationDto.setTheoryPotScore(1.0);
            }

            double v1 = trInheritanceEvaluationDto.getTheoryCombinationScore() + trInheritanceEvaluationDto.getTheoryPathogenesisScore() + trInheritanceEvaluationDto.getTheoryPotScore();
            double theoreticalScore = theoreticalFuture.join();
            double oneOneTotal = v1 + theoreticalScore;
            writer.write("theorySupportScore", oneOneTotal, "第一模块第二部分总得分");
            return oneOneTotal;
        });
        CompletableFuture<Double> diseaseCombinationFuture = scheduler.submit(47, () -> {
            String drugName = drugInfo.getDrugName();
            String indications = drugInfo.getIndications();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "分数（只能是阿拉伯数字组成）");
            resField.put("content", "分析过程");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String recipeSourcePrompt = PromptConstant.getPrompt(PromptConstant.DISEASE_COMBINATION_PROMPT, JSON.toJSONString(properties), drugName, indications);
            JSONObject aiResult = retryUtils.executeWithRetry(recipeSourcePrompt, JSONObject.class, "病证结合模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
            writer.write("diseaseCombinationScore1", aiResult.getString("score"), "病证结合得分");
            writer.write("diseaseCombinationContent1", aiResult.getString("content"), "病证结合得分");

            trInheritanceEvaluationDto.setDiseaseCombinationScore1(extractLastNumber(aiResult.getString("score")));
            trInheritanceEvaluationDto.setDiseaseCombinationContent1(aiResult.getString("content"));

            return trInheritanceEvaluationDto.getDiseaseCombinationScore1();
        });
        CompletableFuture<Double> westMedicineFuture = scheduler.submit(46, () -> {
            String drugName = drugInfo.getDrugName();
            String indications = drugInfo.getIndications();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "分数（只能是阿拉伯数字组成）");
            resField.put("content", "分析过程");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String recipeSourcePrompt = PromptConstant.getPrompt(PromptConstant.WEST_MEDICINE_PROMPT, drugName, indications, JSON.toJSONString(properties));
            JSONObject aiResult = retryUtils.executeWithRetry(recipeSourcePrompt, JSONObject.class, "西医术语模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
            writer.write("diseaseCombinationScore2", aiResult.getString("score"), "西医得分");
            writer.write("diseaseCombinationContent2", aiResult.getString("content"), "西医内容");

            trInheritanceEvaluationDto.setDiseaseCombinationScore2(extractLastNumber(aiResult.getString("score")));
            trInheritanceEvaluationDto.setDiseaseCombinationContent2(aiResult.getString("content"));

            return trInheritanceEvaluationDto.getDiseaseCombinationScore2();
        });
        CompletableFuture<Double> oneTwoPartFuture = CompletableFuture.allOf(
                diseaseCombinationFuture, westMedicineFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double diseaseCombinationScore = diseaseCombinationFuture.join();
            double westMedicineScore = westMedicineFuture.join();
            double oneTwoTotal = diseaseCombinationScore + westMedicineScore;
            writer.write("diseaseCombinationScore", oneTwoTotal, "第一模块第三部分总得分");
            return oneTwoTotal;
        });
        CompletableFuture<Double> onePartFuture = CompletableFuture.allOf(
                recipeSourceFuture, oneOnePartFuture, oneTwoPartFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double recipeSourceScore = recipeSourceFuture.join();
            double oneOnePartScore = oneOnePartFuture.join();
            double oneTwoScore = oneTwoPartFuture.join();

            double total = recipeSourceScore + oneOnePartScore + oneTwoScore;
            writer.write("inheritanceEvaluationTotalScore", total, "第一模块总得分");
            return total;
        });

        // 第二部分
        CompletableFuture<Double> searchGuideFuture = scheduler.submit(80, () -> {
            Map<String, String> guideMap = new HashMap<>();

            String indications = drugInfo.getIndications();
            String drugName = drugInfo.getDrugName();
            Set<String> drugs = new HashSet<>(drugInfo.getDrugSynonymZh());
            drugs.add(drugInfo.getDrugZh());

            BoolQueryBuilder guideQuery = new BoolQueryBuilder();
            guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
            guideQuery.must().add(QueryBuilders.termsQuery("isPaper", "0", "1"));

            guideQuery.must().add(QueryUtils.createGuideQuery(drugName, drugs));
            String scriptStr = "Math.log1p(_score + 1)*0.5";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);

            String scriptStr2 = "Math.log1p(Math.abs(doc['_id'].hashCode() * 1e-9) + 1)*0.1";
            Script script2 = new Script(scriptStr2);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder2 = new ScriptScoreFunctionBuilder(script2);

            FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");

            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[3];
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
            filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder2);

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

            nativeSearchQuery.setMaxResults(30);
            SearchHits<GuideIndex> guideHits = null;
            try {
                guideHits = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
                // 使用guideHits做后续处理
            } catch (Exception e) {
                log.error("Search operation failed after retries", e);
                // 这里可以做失败后降级或补偿逻辑
            }

            List<String> finalGuideBlockList = new ArrayList<>();
            List<JSONObject> guideDtoList = new ArrayList<>();
            List<CompletableFuture<Void>> futures = new ArrayList<>();

            AtomicInteger successCount = new AtomicInteger(0);
            AtomicBoolean shouldStop = new AtomicBoolean(false);
            ExecutorService guideExecutorService = Executors.newFixedThreadPool(4);

            if (guideHits != null && !guideHits.getSearchHits().isEmpty()) {
                for (SearchHit<GuideIndex> guideHit : guideHits) {
                    // 如果已经达到限制，不再提交新任务
                    if (shouldStop.get()) {
                        break;
                    }

                    GuideIndex guideIndex = guideHit.getContent();

                    JSONObject guideInfo = new JSONObject();
                    String guideId = guideIndex.getId();
                    guideInfo.put("id", guideId);
                    String guideTitle = guideIndex.getTitle();
                    guideInfo.put("title", "《" + guideTitle + "》");
                    String zdz = guideIndex.getZdz();
                    guideInfo.put("zdz", zdz);
                    String fbdate = guideIndex.getFbdate();
                    guideInfo.put("fbdate", fbdate);

                    List<JSONObject> finalGuideDtoList = guideDtoList;
                    futures.add(CompletableFuture.runAsync(() -> {
                        try {
                            // 检查是否应该停止
                            if (shouldStop.get()) {
                                return;
                            }
                            assembleGuide(guideTitle, guideId, finalGuideBlockList, finalGuideDtoList, drugName, new ArrayList<>(drugs), guideInfo, successCount, shouldStop);
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                        }
                    }, guideExecutorService));
                }

                try {
                    CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
                } catch (CompletionException e) {
                    log.error(e.getMessage(), e);
                }

                guideExecutorService.shutdown();
                try {
                    if (!guideExecutorService.awaitTermination(100, TimeUnit.SECONDS)) {
                        guideExecutorService.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    guideExecutorService.shutdownNow();
                    Thread.currentThread().interrupt();
                }


                Map<String, String> resField = new HashMap<>();
                resField.put("related", "相关 返回true，不相关 返回false");
                resField.put("content", "请给出药品治疗的重大突发疾病有哪些，若有返回相关信息，若无则返回'无。");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String clinicalPositionAnalysisPrompt = PromptConstant.getPrompt(PromptConstant.JUDGE_GUIDE_PROMPT, JSON.toJSONString(properties), drugName, drugName, String.join("\n", finalGuideBlockList));
                JSONObject aiResult = retryUtils.executeWithRetry(clinicalPositionAnalysisPrompt, JSONObject.class, "重大突发疾病模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String related = aiResult.getString("related");

                if ("false".equals(related)) {
                    resField = new HashMap<>();
                    resField.put("content", "给出药品的临床定位信息。（注意：内容的开始部分不用给出 ‘xxx的临床定位信息如下'，直接给出内容即可。）");
                    properties = new JSONObject();
                    properties.putAll(resField);

                    String clinicalPositionPrompt = PromptConstant.getPrompt(PromptConstant.CLINICAL_POSITION_ANALYSIS_PROMPT, drugName, indications, JSON.toJSONString(properties));
                    JSONObject result = retryUtils.executeWithRetry(clinicalPositionPrompt, JSONObject.class, "临床定位模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                    String content = result.getString("content");

                    trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("3"));
                    trClinicalEvaluationDto.setClinicalPositioningContent(content);
                } else {
                    trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber("5"));
                    trClinicalEvaluationDto.setClinicalPositioningContent(aiResult.getString("content"));
                }
            } else {
                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "给出药品的临床定位信息。（注意：内容的开始部分不用给出 ‘xxx的临床定位信息如下'，直接给出内容即可。）");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);

                String clinicalPositionPrompt = PromptConstant.getPrompt(PromptConstant.CLINICAL_POSITION_PROMPT, drugName, drugName, indications, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(clinicalPositionPrompt, JSONObject.class, "临床定位模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trClinicalEvaluationDto.setClinicalPositioningContent(aiResult.getString("content"));
                trClinicalEvaluationDto.setClinicalPositioningScore(extractLastNumber(aiResult.getString("score")));
            }
            writer.write("clinicalPositioningScore", trClinicalEvaluationDto.getClinicalPositioningScore(), "临床定位得分");
            writer.write("clinicalPositioningContent", trClinicalEvaluationDto.getClinicalPositioningContent(), "临床定位");


            // 方式一：先排序再获取最大值
            List<JSONObject> sortedList = guideDtoList.stream()
                    .sorted((o1, o2) -> {
                        Integer score1 = Optional.ofNullable(o1.getInteger("score")).orElse(0);
                        Integer score2 = Optional.ofNullable(o2.getInteger("score")).orElse(0);
                        return score2.compareTo(score1); // 降序排序
                    })
                    .collect(Collectors.toList());

            // 获取最大score
            int maxScore = guideDtoList.stream()
                    .mapToInt(json -> Optional.ofNullable(json.getInteger("score")).orElse(0))
                    .max()
                    .orElse(0);

            // 为每个对象添加maxScore字段
            sortedList.forEach(json -> json.put("maxScore", maxScore));

            // 更新原列表
            guideDtoList.clear();
            guideDtoList.addAll(sortedList);

            if (CollectionUtils.isNotEmpty(guideDtoList)) {
                guideDtoList.forEach(json -> {
                    guideMap.put(json.getString("title"), json.getString("content"));
                });
            }
            if (guideDtoList.size() > 5) guideDtoList = guideDtoList.subList(0, 5);

//            trClinicalEvaluationDto.getEvidenceItems().add(guideDtoList);
            trClinicalEvaluationDto.setEvidenceRecommendationScore((double) maxScore);

            writer.write("evidenceRecommendationScore", trClinicalEvaluationDto.getEvidenceRecommendationScore(), "证据推荐得分");
            writer.write("evidenceRecommendationContent", guideDtoList, "证据推荐");

            return trClinicalEvaluationDto.getClinicalPositioningScore() + trClinicalEvaluationDto.getEvidenceRecommendationScore();
        });
        CompletableFuture<Double> searchPaperFuture = scheduler.submit(47, () -> {
            log.info("开始执行 文献任务");
            String drugName = drugInfo.getDrugName();
            Set<String> drugs = new HashSet<>(drugInfo.getDrugSynonymZh());
            drugs.add(drugInfo.getDrugZh());

            List<JSONObject> evidenceItems = new ArrayList<>();
            SearchHits<Literature> finalSearchResult = null;
            double finalScore = 0.0;

            // 按优先级依次查找
            // 1. 优先查找类型0
            finalSearchResult = performSearch(drugName, drugs, Arrays.asList(0));
            if (finalSearchResult != null && finalSearchResult.getTotalHits() > 0) {
                finalScore = 5.0;
            } else {
                // 2. 查找类型2
                finalSearchResult = performSearch(drugName, drugs, Arrays.asList(2));
                if (finalSearchResult != null && finalSearchResult.getTotalHits() > 0) {
                    finalScore = 4.0;
                } else {
                    // 3. 查找类型3和5
                    finalSearchResult = performSearch(drugName, drugs, Arrays.asList(3, 5));
                    if (finalSearchResult != null && finalSearchResult.getTotalHits() > 0) {
                        finalScore = 2.0;
                    } else {
                        // 4. 查找类型4、6、7
                        finalSearchResult = performSearch(drugName, drugs, Arrays.asList(4, 6, 7));
                        if (finalSearchResult != null && finalSearchResult.getTotalHits() > 0) {
                            finalScore = 1.0;
                        }
                    }
                }
            }

            // 处理查找结果
            if (finalSearchResult != null && finalSearchResult.getTotalHits() > 0) {
                processSearchResults(finalSearchResult, trClinicalEvaluationDto, evidenceItems, finalScore);
            } else {
                trClinicalEvaluationDto.setClinicalResearchContent("未找到相关文献");
                trClinicalEvaluationDto.setClinicalResearchScore(0.0);
            }

            writer.write("clinicalResearchScore", trClinicalEvaluationDto.getClinicalResearchScore(), "临床研究得分");
            writer.write("clinicalResearchContent", evidenceItems, "临床研究");


            return trClinicalEvaluationDto.getClinicalResearchScore();
        });
        CompletableFuture<Double> twoPartFuture = CompletableFuture.allOf(
                searchGuideFuture, searchPaperFuture
        ).thenApply(v -> {
            trClinicalEvaluationDto.setClinicalDemandScore(0.0);
            writer.write("clinicalDemandScore", trClinicalEvaluationDto.getClinicalDemandScore(), "临床需求得分");
            writer.write("clinicalDemandOption", "", "临床需求");
            writer.write("clinicalDemandContent", "", "临床需求描述");

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

            trClinicalEvaluationDto.setTotalScore();

            // 在这里可以安全地调用 join 来获取结果
            double searchGuideScore = searchGuideFuture.join();
            double searchPaperScore = searchPaperFuture.join();
            double clinicalDemandScore = trClinicalEvaluationDto.getClinicalDemandScore();

            double total = searchGuideScore + searchPaperScore + clinicalDemandScore;
            writer.write("trClinicalEvaluationTotalScore", total, "第二模块总得分");
            return total;
        });

        // 第三部分
        CompletableFuture<Double> adverseReactionFuture = scheduler.submit(46, () -> {
            String drugName = drugInfo.getDrugName();
            String adverseReaction = drugInfo.getAdverseReaction();
            String contraindications = drugInfo.getContraindications();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "分数（只能是阿拉伯数字组成）");
            resField.put("content", "分析过程");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String adverseReactionPrompt = PromptConstant.getPrompt(PromptConstant.ADVERSE_REACTION_PROMPT, drugName, JSON.toJSONString(properties), adverseReaction, contraindications);
            JSONObject aiResult = retryUtils.executeWithRetry(adverseReactionPrompt, JSONObject.class, "不良反应、禁忌模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trSafetyEvaluationDto.setAdverseReactionScore(extractLastNumber(aiResult.getString("score")));

            String content = "";
            if (StringUtils.isNotEmpty(drugInfo.getAdverseReaction())) {
                content += "【不良反应】" + drugInfo.getAdverseReaction().replaceAll("\\n", "");
            }
            if (StringUtils.isNotEmpty(drugInfo.getContraindications())) {
                content += "\n" + "【禁忌】" + drugInfo.getContraindications().replaceAll("\\n", "");
            }
            if (StringUtils.isEmpty(content)) {
                content = "说明书中无【不良反应】与【禁忌】相关内容。";
            }
            trSafetyEvaluationDto.setAdverseReactionContent(content);

            if (content.contains("尚不明确")) {
                trSafetyEvaluationDto.setAdverseReactionScore(0.0);
            }
            writer.write("adverseReactionScore", trSafetyEvaluationDto.getAdverseReactionScore(),"不良反应描述得分");
            writer.write("adverseReactionContent", trSafetyEvaluationDto.getAdverseReactionContent(), "不良反应描述");

            return trSafetyEvaluationDto.getAdverseReactionScore();
        });
        CompletableFuture<Double> warningNoteFuture = scheduler.submit(45, () -> {
            String drugName = drugInfo.getDrugName();
            String drugWarning = drugInfo.getDrugWarning();
            String notes = drugInfo.getNotes();
            String ingredient = drugInfo.getIngredient();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "分数（只能是阿拉伯数字组成）");
            resField.put("content", "分析过程");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String warningNotePrompt = PromptConstant.getPrompt(PromptConstant.WARNING_NOTE_PROMPT, drugName, JSON.toJSONString(properties), drugWarning, notes);
            JSONObject aiResult = retryUtils.executeWithRetry(warningNotePrompt, JSONObject.class, "病证结合模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            boolean hasWarning = StringUtils.isNotEmpty(drugWarning);
            boolean hasNotes = StringUtils.isNotEmpty(notes);

            if (!hasWarning && !hasNotes) {
                // 两者都为空的情况
                trSafetyEvaluationDto.setWarningNoteScore(0.0);
                trSafetyEvaluationDto.setWarningNoteContent("无相关警示或者注意事项");
            } else {
                // 至少有一个不为空，构建内容
                String content = "【警告语】：" + (hasWarning ? drugWarning : "无") + "\n" +
                        "【注意事项】：" + (hasNotes ? notes : "无");
                trSafetyEvaluationDto.setWarningNoteContent(content);
                trSafetyEvaluationDto.setWarningNoteScore(extractLastNumber(aiResult.getString("score")));
            }

            writer.write("warningNoteScore", trSafetyEvaluationDto.getWarningNoteScore(), "说明书中警示语或注意事项得分");
            writer.write("warningNoteContent", trSafetyEvaluationDto.getWarningNoteContent(), "说明书中警示语或注意事项");

            // 处理辅料
            if (StringUtils.isNotEmpty(ingredient) && ingredient.contains("辅料")) {
                trSafetyEvaluationDto.setExcipientScore(1.0);
                if (ingredient.endsWith("\n")) ingredient = ingredient.substring(0, ingredient.length() - 1);
                trSafetyEvaluationDto.setExcipient(ingredient);
            } else {
                trSafetyEvaluationDto.setExcipientScore(0.0);
                trSafetyEvaluationDto.setExcipient("说明书无辅料相关内容");
            }
            writer.write("excipientScore", trSafetyEvaluationDto.getExcipientScore(), "辅料得分");
            writer.write("excipient", trSafetyEvaluationDto.getExcipient(), "辅料");

            return trSafetyEvaluationDto.getWarningNoteScore() + trSafetyEvaluationDto.getExcipientScore();
        });
        CompletableFuture<Double> safetyEvaluationFuture = scheduler.submit(44, () -> {
            BoolQueryBuilder paperQuery = new BoolQueryBuilder();

            String drugName = drugInfo.getDrugName();

            List<String> drugZhs = new ArrayList<>();
            drugZhs.add(drugName);

            StringBuilder query = new StringBuilder();
            BoolQueryBuilder queryBool = new BoolQueryBuilder();

            QueryBuilder bool = FormulaUtil.createQueryBuilder("标题", String.join("|", drugZhs),  1, true, 1, 0, 0);
            paperQuery.must().add(bool);

            QueryBuilder bool1 = FormulaUtil.createQueryBuilder("标题", "安全性", 1, true, 1, 0, 0);
            paperQuery.must().add(bool1);

            QueryBuilder bool2 = FormulaUtil.createQueryBuilder("标题", String.join("|", Arrays.asList("有效", "疗效", "临床疗效", "效果", "联合", "有效性", "联用")), 1, true, 1, 0, 0);
            paperQuery.mustNot().add(bool2);

            // 构建脚本评分函数
            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = buildScoreFunctions();

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.MULTIPLY);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

            List<JSONObject> paperInfoList = new ArrayList<>();
            SearchHits<Literature> search = elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            if (search.getTotalHits() > 0) {
                StringBuilder paperInfo = new StringBuilder();
                int count = 1;

                for (SearchHit<Literature> literatureSearchHit : search) {
                    JSONObject jsonObject1 = new JSONObject();

                    String paperTitle = literatureSearchHit.getContent().getTitle();
                    String paperId = literatureSearchHit.getContent().getId();
                    MongoLiterature paper = null;
                    try {
                        paper = fineScreenFeign.paper(paperId);
                    } catch (Exception e) {
                        log.error("id:{}", paperId);
                    }

                    if (Objects.isNull(paper)) continue;

                    paperInfo.append("(").append(count).append(")《").append(paperTitle).append("》\n");

                    jsonObject1.put("title", HtmlUtil.cleanHtmlTag(paperTitle));
                    if (StringUtils.isBlank(paper.getMethod()) && StringUtils.isBlank(paper.getSummary())) {
                        continue;
                    }
                    if (StringUtils.isNotEmpty(paper.getMethod())) {
                        paperInfo.append("研究方法：").append(paper.getMethod()).append("\n");
                        jsonObject1.put("content", paper.getMethod().replaceAll("\\[|\\]", ""));
                    } else {
                        paperInfo.append("摘要：").append(literatureSearchHit.getContent().getSummary()).append("\n");
                        jsonObject1.put("content", literatureSearchHit.getContent().getSummary());
                    }
                    paperInfoList.add(jsonObject1);
                    count++;
                }

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "分数（只能是阿拉伯数字组成）");
                resField.put("content", "分析过程");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String paperZdzTypeJudgePrompt = PromptConstant.getPrompt(PromptConstant.PAPER_ZDZ_TYPE_JUDGE_PROMPT, drugName, JSON.toJSONString(properties), paperInfo);
                JSONObject aiResult = retryUtils.executeWithRetry(paperZdzTypeJudgePrompt, JSONObject.class, "文献类型模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setSafetyReevaluationContent(paperInfo.toString());
                trSafetyEvaluationDto.setSafetyReevaluationScore(extractLastNumber(aiResult.getString("score")));
            } else {
                trSafetyEvaluationDto.setSafetyReevaluationScore(0.0);
                trSafetyEvaluationDto.setSafetyReevaluationContent("未找到安全性相关内容");
            }
            writer.write("safetyReevaluationScore", trSafetyEvaluationDto.getSafetyReevaluationScore(), "安全性再评价得分");
            writer.write("safetyReevaluationContent", paperInfoList, "安全性再评价");
            
            return trSafetyEvaluationDto.getSafetyReevaluationScore();
        });
        CompletableFuture<Double> threeOnePartFuture = CompletableFuture.allOf(
                adverseReactionFuture, warningNoteFuture, safetyEvaluationFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double adverseReactionScore = adverseReactionFuture.join();
            double warningNoteScore = warningNoteFuture.join();
            double safetyEvaluationScore = safetyEvaluationFuture.join();

            double total = adverseReactionScore + warningNoteScore + safetyEvaluationScore;
            writer.write("safetyInfoScore", total, "第三模块第一部分总得分");
            return total;
        });
        CompletableFuture<Double> childrenFuture = scheduler.submit(43, () -> {
            String childrenMedicine = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String childExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_CHILDREN_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(childExtractPrompt, JSONObject.class, "儿童用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasChildrenInfo = aiResult.getString("hasChildrenInfo");
                if ("true".equals(hasChildrenInfo)) {
                    childrenMedicine = aiResult.getString("childrenContent");
                }
            }

            if (StringUtils.isBlank(childrenMedicine)) {
                String txt = getTxt(drugInfo, "儿童用药", "儿童");
                if (StringUtils.isNotEmpty(txt)) {
                    childrenMedicine = txt;
                }
            }

            if (StringUtils.isNotBlank(childrenMedicine)) {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于儿童用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String childPrompt = PromptConstant.getPrompt(PromptConstant.CHILD_PROMPT, childrenMedicine, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(childPrompt, JSONObject.class, "儿童用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setPediatricDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setPediatricDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setPediatricDrugUseContent("");
                }
                writer.write("pediatricDrugUseScore", trSafetyEvaluationDto.getPediatricDrugUseScore(), "儿童用药得分");
                writer.write("pediatricDrugUseContent", trSafetyEvaluationDto.getPediatricDrugUseContent(), "儿童用药内容");
            } else {
                trSafetyEvaluationDto.setPediatricDrugUseScore(0.0);
                trSafetyEvaluationDto.setPediatricDrugUseContent("");
                writer.write("pediatricDrugUseScore", "", "儿童用药得分");
                writer.write("pediatricDrugUseContent", "", "儿童用药内容");
            }

            return trSafetyEvaluationDto.getPediatricDrugUseScore();
        });
        CompletableFuture<Double> pregnancyFuture = scheduler.submit(42, () -> {
            String pregnancyMedicine = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String pregnancyExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_PREGNANCY_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(pregnancyExtractPrompt, JSONObject.class, "妊娠期妇女用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasChildrenInfo = aiResult.getString("hasPregnancyInfo");
                if ("true".equals(hasChildrenInfo)) {
                    pregnancyMedicine = aiResult.getString("pregnancyContent");
                }
            }

            if (StringUtils.isBlank(pregnancyMedicine)) {
                String txt = getTxt(drugInfo, "妊娠期妇女用药", "妊娠");
                if (StringUtils.isNotEmpty(txt)) {
                    pregnancyMedicine = txt;
                }
            }

            if (StringUtils.isNotBlank(pregnancyMedicine)) {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于妊娠期妇女用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String pregnancyPrompt = PromptConstant.getPrompt(PromptConstant.PREGNANCY_PROMPT, pregnancyMedicine, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(pregnancyPrompt, JSONObject.class, "妊娠期妇女用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setPregnancyDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setPregnancyDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setPregnancyDrugUseContent("");
                }
                writer.write("pregnancyDrugUseScore", trSafetyEvaluationDto.getPregnancyDrugUseScore(), "妊娠期妇女得分");
                writer.write("pregnancyDrugUseContent", trSafetyEvaluationDto.getPregnancyDrugUseContent(), "妊娠期妇女");
            } else {
                trSafetyEvaluationDto.setPregnancyDrugUseScore(0.0);
                trSafetyEvaluationDto.setPregnancyDrugUseContent("");
                writer.write("pregnancyDrugUseScore", "", "妊娠期妇女得分");
                writer.write("pregnancyDrugUseContent", "", "妊娠期妇女");
            }

            return trSafetyEvaluationDto.getPregnancyDrugUseScore();
        });
        CompletableFuture<Double> lactationFuture = scheduler.submit(41, () -> {
            String lactationMedicine = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String lactationExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_LACTATION_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(lactationExtractPrompt, JSONObject.class, "哺乳期妇女用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasBreastfeedingInfo = aiResult.getString("hasBreastfeedingInfo");
                if ("true".equals(hasBreastfeedingInfo)) {
                    lactationMedicine = aiResult.getString("breastfeedingContent");
                }
            }

            if (StringUtils.isBlank(lactationMedicine)) {
                String txt = getTxt(drugInfo, "哺乳期妇女用药", "哺乳");
                if (StringUtils.isNotEmpty(txt)) {
                    drugInfo.setLactation(txt);
                }
            }

            if (StringUtils.isNotBlank(lactationMedicine)) {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于哺乳期妇女用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String lactationPrompt = PromptConstant.getPrompt(PromptConstant.LACTATION_PROMPT, lactationMedicine, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(lactationPrompt, JSONObject.class, "哺乳期妇女用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setLactationDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setLactationDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setLactationDrugUseContent("");
                }
                writer.write("lactationDrugUseScore", trSafetyEvaluationDto.getLactationDrugUseScore(), "哺乳期妇女得分");
                writer.write("lactationDrugUseContent", trSafetyEvaluationDto.getLactationDrugUseContent(), "哺乳期妇女");
            } else {
                trSafetyEvaluationDto.setLactationDrugUseScore(0.0);
                trSafetyEvaluationDto.setLactationDrugUseContent("");
                writer.write("lactationDrugUseScore", "", "哺乳期妇女得分");
                writer.write("lactationDrugUseContent", "", "哺乳期妇女");
            }


            return trSafetyEvaluationDto.getLactationDrugUseScore();
        });
        CompletableFuture<Double> liverFuture = scheduler.submit(40, () -> {
            String liverMedicine = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String liverExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_LIVER_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(liverExtractPrompt, JSONObject.class, "肝功能异常用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasLiverInfo = aiResult.getString("hasLiverInfo");
                if ("true".equals(hasLiverInfo)) {
                    liverMedicine = aiResult.getString("liverContent");
                }
            }

            if (StringUtils.isBlank(liverMedicine)) {
                String txt = getTxt(drugInfo, "肝功能异常的用药", "肝");
                if (StringUtils.isNotEmpty(txt)) {
                    liverMedicine = txt;
                }
            }

            if (StringUtils.isNotBlank(liverMedicine)) {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于肝功能异常用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String liverPrompt = PromptConstant.getPrompt(PromptConstant.LIVER_PROMPT, liverMedicine, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(liverPrompt, JSONObject.class, "肝功能异常用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent("");
                }
                writer.write("liverDysfunctionDrugUseScore", trSafetyEvaluationDto.getLiverDysfunctionDrugUseScore(), "肝功能异常得分");
                writer.write("liverDysfunctionDrugUseContent", trSafetyEvaluationDto.getLiverDysfunctionDrugUseContent(), "肝功能异常");
            } else {
                trSafetyEvaluationDto.setLiverDysfunctionDrugUseScore(0.0);
                trSafetyEvaluationDto.setLiverDysfunctionDrugUseContent("");
                writer.write("liverDysfunctionDrugUseScore", "", "肝功能异常得分");
                writer.write("liverDysfunctionDrugUseContent", "", "肝功能异常");
            }

            return trSafetyEvaluationDto.getLiverDysfunctionDrugUseScore();
        });
        CompletableFuture<Double> kidneyFuture = scheduler.submit(39, () -> {
            String kidneyMedicine = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String kidneyExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_KIDNEY_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(kidneyExtractPrompt, JSONObject.class, "肾功能异常用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasRenalInfo = aiResult.getString("hasRenalInfo");
                if ("true".equals(hasRenalInfo)) {
                    kidneyMedicine = aiResult.getString("renalContent");
                }
            }
            if (StringUtils.isBlank(kidneyMedicine)) {
                String txt = getTxt(drugInfo, "肾功能异常的用药", "肾");
                if (StringUtils.isNotEmpty(txt)) {
                    kidneyMedicine = txt;
                }
            }

            if (StringUtils.isNotBlank(kidneyMedicine)) {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于肾功能异常用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String kidneyPrompt = PromptConstant.getPrompt(PromptConstant.KIDNEY_PROMPT, kidneyMedicine, drugName, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(kidneyPrompt, JSONObject.class, "肾功能异常用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent("");
                }
                writer.write("kidneyDysfunctionDrugUseScore", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseScore(), "肾功能异常得分");
                writer.write("kidneyDysfunctionDrugUseContent", trSafetyEvaluationDto.getKidneyDysfunctionDrugUseContent(), "肾功能异常");
            } else {
                trSafetyEvaluationDto.setKidneyDysfunctionDrugUseScore(0.0);
                trSafetyEvaluationDto.setKidneyDysfunctionDrugUseContent("");
                writer.write("kidneyDysfunctionDrugUseScore", "", "肾功能异常得分");
                writer.write("kidneyDysfunctionDrugUseContent", "", "肾功能异常");
            }

            return trSafetyEvaluationDto.getKidneyDysfunctionDrugUseScore();
        });
        CompletableFuture<Double> athleteFuture = scheduler.submit(38, () -> {
            String drugName = drugInfo.getDrugName();

            String athlete = "";
            String drugInfoStr = drugInfo.toString();
            if (StringUtils.isNotBlank(drugInfoStr)) {
                String athleteExtractPrompt = PromptConstant.getPrompt(PromptConstant.CONTENT_EXTRACTION_ATHLETE_PROMPT, drugInfoStr);
                JSONObject aiResult = retryUtils.executeWithRetry(athleteExtractPrompt, JSONObject.class, "肾功能异常用药内容提取", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                String hasAthleteInfo = aiResult.getString("hasAthleteInfo");
                if ("true".equals(hasAthleteInfo)) {
                    athlete = aiResult.getString("athleteContent");
                }
            }

            if (StringUtils.isNotBlank(athlete)) {
                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
                resField.put("content", "挑选出的关于运动员用药的相关内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String athletePrompt = PromptConstant.getPrompt(PromptConstant.ATHLETE_PROMPT, drugName, athlete, JSON.toJSONString(properties));
                JSONObject aiResult = retryUtils.executeWithRetry(athletePrompt, JSONObject.class, "运动员用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                trSafetyEvaluationDto.setAthleteDrugUseScore(extractLastNumber(aiResult.getString("score")));
                String content = aiResult.getString("content");
                if (StringUtils.isNotBlank(content)) {
                    trSafetyEvaluationDto.setAthleteDrugUseContent(content);
                } else {
                    trSafetyEvaluationDto.setAthleteDrugUseContent("未明确运动员不可用。");
                }
                writer.write("athleteDrugUseScore", trSafetyEvaluationDto.getAthleteDrugUseScore(), "运动员得分");
                writer.write("athleteDrugUseContent", trSafetyEvaluationDto.getAthleteDrugUseContent(), "运动员");

            } else {
                trSafetyEvaluationDto.setAthleteDrugUseScore(1.0);
                trSafetyEvaluationDto.setAthleteDrugUseContent("未明确运动员不可用。");
                writer.write("athleteDrugUseScore", 1, "运动员得分");
                writer.write("athleteDrugUseContent", "说明书中未提及运动员用药信息。", "运动员");
            }
            
            return trSafetyEvaluationDto.getAthleteDrugUseScore();
        });
        CompletableFuture<Double> threeTwoPartFuture = CompletableFuture.allOf(
                childrenFuture, pregnancyFuture, lactationFuture, liverFuture, kidneyFuture, athleteFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double childrenScore = childrenFuture.join();
            double pregnancyScore = pregnancyFuture.join();
            double lactationScore = lactationFuture.join();
            double liverScore = liverFuture.join();
            double kindneyScore = kidneyFuture.join();
            double athleteScore = athleteFuture.join();

            double total = childrenScore + pregnancyScore + lactationScore + liverScore + kindneyScore + athleteScore;
            writer.write("crowdRestrictionScore", total, "第三模块第二部分总得分");
            return total;
        });
        CompletableFuture<Double> adverseReactionStratificationFuture = scheduler.submit(37, () -> {
            String drugName = drugInfo.getDrugName();
            String adverseReaction = drugInfo.getAdverseReaction();
            String notes = drugInfo.getNotes();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "打分（务必是数字:int或者double类型，其他的内容不要）");
            resField.put("content", "请给出药品不良反应症状如何");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String adverPrompt = PromptConstant.getPrompt(PromptConstant.ADVER_PROMPT, drugName, adverseReaction, notes, JSON.toJSONString(properties));
            JSONObject aiResult = retryUtils.executeWithRetry(adverPrompt, JSONObject.class, "不良反应分级模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trSafetyEvaluationDto.setAdverseReactionStratificationScore(extractLastNumber(aiResult.getString("score")));
            trSafetyEvaluationDto.setAdverseReactionStratificationContent(aiResult.getString("content"));
            writer.write("adverseReactionStratificationScore", trSafetyEvaluationDto.getAdverseReactionStratificationScore(), "不良反应分级得分");
            writer.write("adverseReactionStratificationContent", trSafetyEvaluationDto.getAdverseReactionStratificationContent(), "不良反应分级");

            return trSafetyEvaluationDto.getAdverseReactionStratificationScore();
        });
        CompletableFuture<Double> threePartFuture = CompletableFuture.allOf(
                threeOnePartFuture, threeTwoPartFuture, adverseReactionStratificationFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double threeOnePartScore = threeOnePartFuture.join();
            double threeTwoPartScore = threeTwoPartFuture.join();
            double adverseReactionStratificationScore = adverseReactionStratificationFuture.join();

            double total = threeOnePartScore + threeTwoPartScore + adverseReactionStratificationScore;
            writer.write("safetyEvaluationTotalScore", total, "第三模块总得分");
            return total;
        });
        
        // 第四部分
        CompletableFuture<Double> frequencyFuture = scheduler.submit(36, () -> {
            String drugName = drugInfo.getDrugName();
            String usageAndDosage = drugInfo.getUsageAndDosage();

            Map<String, String> resField = new HashMap<>();
            resField.put("content", "请给出药品用药频次打分的相关依据");
            resField.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String adverPrompt = PromptConstant.getPrompt(PromptConstant.FREQUENCY_PROMPT, JSON.toJSONString(properties), drugName, usageAndDosage);
            JSONObject aiResult = retryUtils.executeWithRetry(adverPrompt, JSONObject.class, "用药频次模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trPolicyEvaluationDto.setAdministrationFrequencyScore(extractLastNumber(aiResult.getString("score")));
            trPolicyEvaluationDto.setAdministrationFrequencyContent(aiResult.getString("content"));
            writer.write("administrationFrequencyScore", trPolicyEvaluationDto.getAdministrationFrequencyScore(), "频次得分");
            writer.write("administrationFrequencyContent", trPolicyEvaluationDto.getAdministrationFrequencyContent(), "频次");

            return trPolicyEvaluationDto.getAdministrationFrequencyScore();
        });
        CompletableFuture<Double> packagingFuture = scheduler.submit(35, () -> {
            String drugName = drugInfo.getDrugName();
            String usageAndDosage = drugInfo.getUsageAndDosage();
            String specifications = drugInfo.getSpecifications();
            String pack = drugInfo.getPack();

            Map<String, String> resField = new HashMap<>();
            resField.put("content", "请给出药品用药频次打分的相关依据");
            resField.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String packagingPrompt = PromptConstant.getPrompt(PromptConstant.PACKAGING_PROMPT, drugName, usageAndDosage, specifications, pack);
            JSONObject aiResult = retryUtils.executeWithRetry(packagingPrompt, JSONObject.class, "包装模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            // 包装规格
            String packageQuantity = aiResult.getString("packagQuantity") + aiResult.getString("packagQuantityUnit");
            // 单次用药计量
            String singleDose = aiResult.getString("singleDoseUsage") + aiResult.getString("singleDoseUsageUnit");
            // 频率
            String medicationFrequency = aiResult.getString("medicationFrequency") + aiResult.getString("medicationFrequencyUnit");

            String minPackag = drugInfo.getNumber();
            if (StringUtils.isEmpty(minPackag)) {
                minPackag = aiResult.getString("miniQuantity") + aiResult.getString("miniQuantityUnit");
            }
            String packingOne = "";
            // 包装规格计算
            if (StringUtils.isNotBlank(packageQuantity) && StringUtils.isNotBlank(singleDose) && StringUtils.isNotBlank(medicationFrequency)) {
                String packageCAPrompt = PromptConstant.getPrompt(PromptConstant.PACKING_CA_PROMPT, packageQuantity, singleDose, medicationFrequency, pack, usageAndDosage);
                packingOne = retryUtils.executeWithRetry(packageCAPrompt, String.class, "包装内部模型分析2", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                if (StringUtils.isNotBlank(packingOne)) {
                    double packingDouble = Double.parseDouble(packingOne);
                    boolean doubleInteger = packingDouble == (int) packingDouble;
                    if (doubleInteger) {
                        writer.write("packagingSpecificationScore", 1, "包装规格得分");
                        writer.write("packagingSpecificationOption", "1", "包装规格选项");
                        trPolicyEvaluationDto.setPackagingSpecificationScore(1.00);
                        trPolicyEvaluationDto.setPackagingSpecificationOption("1");
                    } else {
                        writer.write("packagingSpecificationScore", 0.5, "包装规格得分");
                        writer.write("packagingSpecificationOption", "2", "包装规格选项");
                        trPolicyEvaluationDto.setPackagingSpecificationScore(0.50);
                        trPolicyEvaluationDto.setPackagingSpecificationOption("2");
                    }
                } else {
                    trPolicyEvaluationDto.setPackagingSpecificationScore(0.0);
                    trPolicyEvaluationDto.setPackagingSpecificationOption("");
                    writer.write("packagingSpecificationScore", 0, "包装规格得分");
                    writer.write("packagingSpecificationOption", "", "包装规格选项");
                }
            } else {
                trPolicyEvaluationDto.setPackagingSpecificationScore(0.0);
                trPolicyEvaluationDto.setPackagingSpecificationOption("");
                writer.write("packagingSpecificationScore", 0, "包装规格得分");
                writer.write("packagingSpecificationOption", "", "包装规格选项");
            }

            JSONObject jsonObject = new JSONObject();
            jsonObject.put("packagQuantity", packageQuantity);
            jsonObject.put("singleDose", singleDose);
            jsonObject.put("medicationFrequency", medicationFrequency);
            jsonObject.put("usageAndDosage", drugInfo.getUsageAndDosage());
            jsonObject.put("pack", drugInfo.getPack());

            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("singleDose", singleDose);
            jsonObject1.put("medicationFrequency", medicationFrequency);
            jsonObject1.put("usageAndDosage", drugInfo.getUsageAndDosage());
            jsonObject1.put("price", "");
            
            writer.write("dailyTreatmentCostJson", jsonObject1, "日均治疗费用信息");
            writer.write("packagingSpecificationJson", jsonObject, "包装规格信息");

            // 大包装
            trPolicyEvaluationDto.setLargePackageAdoptionScore(0.0);
            writer.write("largePackageAdoptionScore", trPolicyEvaluationDto.getLargePackageAdoptionScore(), "采用大包装得分");
            writer.write("largePackageAdoptionOption", "", "采用大包装选项");

            JSONObject jsonObject2 = new JSONObject();
            jsonObject2.put("packagQuantity", packageQuantity);
            jsonObject2.put("singleDose", singleDose);
            jsonObject2.put("usageAndDosage", usageAndDosage);
            jsonObject2.put("pack", packingOne);
            writer.write("largePackageAdoptionJson", jsonObject2, "采用大包装信息");

            // 单剂量
            String dingleDosePrompt = PromptConstant.getPrompt(PromptConstant.PACKING_SINGLE_PROMPT, minPackag, singleDose, usageAndDosage, specifications);
            String dingleDose = retryUtils.executeWithRetry(dingleDosePrompt, String.class, "包装内部模型分析3", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            double singleDoseDouble = 0.0;
            try {
                singleDoseDouble = Double.parseDouble(dingleDose);
            } catch (Exception e) {
                log.error("单剂量得分异常{}", dingleDose);
            }
            if (singleDoseDouble != 0.0) {
                if (singleDoseDouble == 1) {
                    trPolicyEvaluationDto.setSingleDoseScore(1.00);
                    trPolicyEvaluationDto.setSingleDoseOption("1");
                } else if (singleDoseDouble > 1) {
                    trPolicyEvaluationDto.setSingleDoseScore(0.8);
                    trPolicyEvaluationDto.setSingleDoseOption("2");
                } else if (singleDoseDouble < 1) {
                    trPolicyEvaluationDto.setSingleDoseScore(0.5);
                    trPolicyEvaluationDto.setSingleDoseOption("3");
                }
            } else {
                trPolicyEvaluationDto.setSingleDoseScore(1.00);
                trPolicyEvaluationDto.setSingleDoseOption("");
            }
            writer.write("singleDoseScore", trPolicyEvaluationDto.getSingleDoseScore(), "临床常用单次用量与药品规格的适配性得分");
            writer.write("singleDoseOption", trPolicyEvaluationDto.getSingleDoseOption(), "临床常用单次用量与药品规格适配选项");

            JSONObject jsonObject3 = new JSONObject();
            jsonObject3.put("miniQuantity", minPackag);
            jsonObject3.put("singleDose", singleDose);
            jsonObject3.put("usageAndDosage", usageAndDosage);
            // 包装
            jsonObject3.put("specifications", specifications);
            writer.write("singleDoseJson", jsonObject3, "临床常用单次用量与药品规格信息");

            return trPolicyEvaluationDto.getPackagingSpecificationScore() + trPolicyEvaluationDto.getLargePackageAdoptionScore() + trPolicyEvaluationDto.getSingleDoseScore();
        });
        CompletableFuture<Double> courseFuture = scheduler.submit(34, () -> {
            String drugName = drugInfo.getDrugName();

            Map<String, String> resField = new HashMap<>();
            resField.put("content", "请给出药品疗程相关的内容的打分的相关依据");
            resField.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String packagingPrompt = PromptConstant.getPrompt(PromptConstant.COURSE_PROMPT, JSON.toJSONString(properties), drugName, drugInfo.toString());
            JSONObject aiResult = retryUtils.executeWithRetry(packagingPrompt, JSONObject.class, "包装模型分析1", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trPolicyEvaluationDto.setCourseOfTreatmentScore(extractLastNumber(aiResult.getString("score")));
            trPolicyEvaluationDto.setCourseOfTreatmentContent(aiResult.getString("content"));
            writer.write("courseOfTreatmentScore", trPolicyEvaluationDto.getCourseOfTreatmentScore(), "疗程得分");
            writer.write("courseOfTreatmentContent", trPolicyEvaluationDto.getCourseOfTreatmentContent(), "疗程内容");

            return trPolicyEvaluationDto.getCourseOfTreatmentScore();
        });
        CompletableFuture<Double> storageFuture = scheduler.submit(33, () -> {
            String drugName = drugInfo.getDrugName();
            String storage = drugInfo.getStorage();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String packagingPrompt = PromptConstant.getPrompt(PromptConstant.STORAGE_PROMPT, JSON.toJSONString(properties), drugName, storage);
            JSONObject aiResult = retryUtils.executeWithRetry(packagingPrompt, JSONObject.class, "贮藏模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trPolicyEvaluationDto.setStorageScore(extractLastNumber(aiResult.getString("score")));
            trPolicyEvaluationDto.setStorageContent(storage);
            writer.write("storageScore", trPolicyEvaluationDto.getStorageScore(), "贮藏得分");
            writer.write("storageContent", trPolicyEvaluationDto.getStorageContent(), "贮藏内容");

            return trPolicyEvaluationDto.getStorageScore();
        });
        CompletableFuture<Double> validityFuture = scheduler.submit(32, () -> {
            String drugName = drugInfo.getDrugName();
            String indate = drugInfo.getIndate();

            Map<String, String> resField = new HashMap<>();
            resField.put("score", "打分（务必是数字:int或者double类型）");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String packagingPrompt = PromptConstant.getPrompt(PromptConstant.VALIDITY_PROMPT, JSON.toJSONString(properties), drugName, indate);
            JSONObject aiResult = retryUtils.executeWithRetry(packagingPrompt, JSONObject.class, "有效期模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            trPolicyEvaluationDto.setValidityPeriodScore(extractLastNumber(aiResult.getString("score")));
            trPolicyEvaluationDto.setValidityPeriodContent(indate);
            writer.write("validityPeriodScore", trPolicyEvaluationDto.getValidityPeriodScore(), "有效期得分");
            writer.write("validityPeriodContent", trPolicyEvaluationDto.getValidityPeriodContent(), "有效期内容");

            return trPolicyEvaluationDto.getValidityPeriodScore();
        });
        CompletableFuture<Double> fourOnePartFuture = CompletableFuture.allOf(
                frequencyFuture, packagingFuture, courseFuture, storageFuture, validityFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double frequencyScore = frequencyFuture.join();
            double packagingScore = packagingFuture.join();
            double courseScore = courseFuture.join();
            double storageScore = storageFuture.join();
            double validityScore = validityFuture.join();

            double total = frequencyScore + packagingScore + courseScore + storageScore + validityScore;
            writer.write("suitabilityScore", total, "第四模块第一部分总得分");
            return total;
        });
        CompletableFuture<Double> chineseMedicineFuture = scheduler.submit(31, () -> {
            // 处理保护品种
            if (StringUtils.isNotEmpty(drugInfo.getIsProtected())) {
                trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
                String protectionLevel = drugInfo.getProtectionLevel();
                String protectionPeriod = drugInfo.getProtectionPeriod();
                if (StringUtils.isNotEmpty(protectionLevel)) {
                    trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent(protectionLevel + protectionPeriod);
                    if (protectionLevel.contains("级") && !protectionLevel.contains("已过保护期")) {
                        trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(3.0);
                    } else if (protectionLevel.contains("已过保护期")) {
                        trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(2.0);
                    } else {
                        trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
                    }
                }
            } else {
                trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionScore(1.0);
                trPolicyEvaluationDto.setNationalTraditionalChineseMedicineProtectionContent("该产品不是国家保护品种");
            }
            writer.write("nationalTraditionalChineseMedicineProtectionScore", trPolicyEvaluationDto.getNationalTraditionalChineseMedicineProtectionScore(), "保护品种得分");
            writer.write("nationalTraditionalChineseMedicineProtectionContent", trPolicyEvaluationDto.getNationalTraditionalChineseMedicineProtectionContent(), "保护品种内容");

            return trPolicyEvaluationDto.getNationalTraditionalChineseMedicineProtectionScore();
        });
        
        CompletableFuture<Double> patentsFuture = scheduler.submit(30, () -> {
            Criteria criteria = new Criteria()
                    .andOperator(Criteria.where("title").regex(".*" + drugInfo.getDrugName() + ".*"), Criteria.where("patentee").is(drugInfo.getManufacturer()))
                    .and("applicationTime").exists(true);

            // 创建 Query 对象并添加 Criteria 和排序
            Query query = new Query(criteria);
            query.with(Sort.by(Sort.Direction.DESC, "applicationTime"));
            List<Patent> patents = mongoTemplate.find(query, Patent.class);

            if (CollUtil.isNotEmpty(patents)) {
                // 拼接专利信息
                double patentScore = 0.0;
                List<String> patentsList = new ArrayList<>();
                StringBuilder patentInfo = new StringBuilder();
                for (int i = 0; i < patents.size(); i++) {
                    Patent patent = patents.get(i);
                    patentInfo.append("（").append(i + 1).append("）").append(patent.getTitle()).append("\n")
                            .append("  专利类型：").append(patent.getType()).append("；申请/专利号：").append(patent.getPatentNumber()).append("；申请/专利权人：").append(String.join("、", patent.getPatentee())).append("\n")
                            .append("  申请日：").append(patent.getApplicationTime()).append("；公开日：").append(patent.getPublicDate()).append("； 法律状态信息：").append(patent.getStatusInformation());
                    patentsList.add(patent.getStatusInformation());
                    // 如果不是最后一个元素，则添加换行符
                    if (i < patents.size() - 1) {
                        patentInfo.append("\n");
                    }
                }
                patentScore = GptCallUtil.getPatentScoreMax(patentsList);
                trPolicyEvaluationDto.setPatentScore(patentScore);
                trPolicyEvaluationDto.setPatentNumber(patentInfo.toString());
            } else {
                String drugName = drugInfo.getDrugName();

                Map<String, String> resField = new HashMap<>();
                resField.put("score", "打分（务必是数字:int或者double类型）");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String packagingPrompt = PromptConstant.getPrompt(PromptConstant.PATENTS_PROMPT, drugName);
                String aiResult = retryUtils.executeWithRetry(packagingPrompt, String.class, "有效期模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                if (aiResult.contains("无相关专利") || aiResult.contains("暂未查询到药品的相关专利信息")) {
                    trPolicyEvaluationDto.setPatentScore(0.0);
                    trPolicyEvaluationDto.setPatentNumber("无相关专利");
                } else {
                    trPolicyEvaluationDto.setPatentScore(1.0);
                    trPolicyEvaluationDto.setPatentNumber(aiResult);
                }
            }
            writer.write("patentScore", trPolicyEvaluationDto.getPatentScore(), "专利相关分数");
            writer.write("patentNumber", trPolicyEvaluationDto.getPatentNumber(), "专利内容");

            return trPolicyEvaluationDto.getPatentScore();
        });
        CompletableFuture<Double> fourOtherPartFuture = scheduler.submit(29, () -> {
            // 处理药典
            if (StringUtils.isNotEmpty(drugInfo.getIsInclude()) && "收载在《中国药典》中。".equals(drugInfo.getIsInclude())) {
                String chineseMedicine = "本品已收录在《中国药典》中。";
                trPolicyEvaluationDto.setChinesePharmacopoeiaScore(1.0);
                trPolicyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
            } else {
                String chineseMedicine = "本品未收录在《中国药典》中。";
                trPolicyEvaluationDto.setChinesePharmacopoeiaScore(0.0);
                trPolicyEvaluationDto.setChinesePharmacopoeiaContent(chineseMedicine);
            }
            writer.write("chinesePharmacopoeiaScore", trPolicyEvaluationDto.getChinesePharmacopoeiaScore(), "药典得分");
            writer.write("chinesePharmacopoeiaContent", trPolicyEvaluationDto.getChinesePharmacopoeiaContent(), "药典内容");


            // 处理独家品种结果
            List<DrugInfoNew> drugName = mongoTemplate.find(Query.query(Criteria.where("drugName").is(drugInfo.getDrugName())), DrugInfoNew.class);
            Set<String> manufacturers = drugName.stream()
                    .map(DrugInfoNew::getManufacturer)
                    .filter(Objects::nonNull)
                    .map(manufacturer -> {
                        if (manufacturer.contains("集团")) {
                            return manufacturer.split("集团", 2)[0] + "集团";
                        }
                        return manufacturer;
                    })
                    .collect(Collectors.toCollection(HashSet::new));


            if (manufacturers.size() <= 1) {
                trPolicyEvaluationDto.setExclusiveVarietyScore(1.0);
                trPolicyEvaluationDto.setExclusiveVarietyInfo("该药品是独家品种");
            } else {
                trPolicyEvaluationDto.setExclusiveVarietyScore(0.0);
                StringBuilder s = new StringBuilder();
                int i = 0;
                for (String manufacturer : manufacturers) {
                    s.append(drugInfo.getDrugName()).append("-").append(manufacturer).append("\n");
                    if (i >= 2) {
                        break;
                    }
                    i++;
                }
                trPolicyEvaluationDto.setExclusiveVarietyInfo("该药品不是独家品种");
                trPolicyEvaluationDto.setExclusiveVarietyInfo(s.substring(0, s.length() - 1));
            }

            writer.write("exclusiveVarietyScore", trPolicyEvaluationDto.getExclusiveVarietyScore(), "独家品种得分");
            writer.write("exclusiveVarietyInfo", trPolicyEvaluationDto.getExclusiveVarietyInfo(), "独家品种内容");

            return trPolicyEvaluationDto.getChinesePharmacopoeiaScore() + trPolicyEvaluationDto.getExclusiveVarietyScore();
        });
        CompletableFuture<Double> fourThreePartFuture = CompletableFuture.allOf(
                patentsFuture, fourOtherPartFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double patentsScore = patentsFuture.join();
            double fourPackagingScore = fourOtherPartFuture.join();

            double total = patentsScore + fourPackagingScore;
            writer.write("additionalZodiacScore", total, "第四模块第三部分总得分");
            return total;
        });
        
        CompletableFuture<Double> fourPartFuture = CompletableFuture.allOf(
                fourOnePartFuture, chineseMedicineFuture, fourThreePartFuture
        ).thenApply(v -> {
            // 在这里可以安全地调用 join 来获取结果
            double fourOnePartScore = fourOnePartFuture.join();
            double chineseMedicineScore = chineseMedicineFuture.join();
            double fourThreePartScore = fourThreePartFuture.join();

            double total = fourOnePartScore + chineseMedicineScore + fourThreePartScore ;
            writer.write("technologyEvaluationScore", total, "第四模块总得分");
            return total;
        });


        CompletableFuture<Double> fivePartFuture = scheduler.submit(28, () -> {
            //提前获取经济性日均治疗费用
            JSONObject jsonObject1 = new JSONObject();
            
            writer.write("marketUniquenessScore", trMarketEvaluationDto.getMarketUniquenessScore(), "市场独特性得分");
            writer.write("marketUniquenessOption", "", "市场独特性选项");
            writer.write("marketUniquenessContent", "", "市场独特性描述");


            List<JSONObject> idMatchList = new ArrayList<>();

            BoolQueryBuilder paperQuery = new BoolQueryBuilder();

            List<String> drugSynonym = new ArrayList<>();
            drugSynonym.add(drugInfo.getDrugName());

            StringBuilder query = new StringBuilder();
            StringBuilder stringBuilder = QueryUtils.montageForCustomizeName(query, drugSynonym, "标题,摘要", "OR");
            //检索式拼接条件
            String formula = new SearchFormula().execute(query.toString(), 1, 1, 0).toString();
            paperQuery.must().add(QueryBuilders.wrapperQuery(formula));


            TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 12);
            paperQuery.must().add(termQueryBuilder);

            // 构建脚本评分函数
            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = buildScoreFunctions();

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.MULTIPLY);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
            nativeSearchQuery.setMaxResults(30);

            SearchHits<Literature> paperHits = null;
            try {
                paperHits = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
                // 使用guideHits做后续处理
            } catch (Exception e) {
                log.error("Search operation failed after retries", e);
                // 这里可以做失败后降级或补偿逻辑
            }

            if (paperHits != null && paperHits.getTotalHits() > 0) {
                StringBuilder paperInfo = new StringBuilder();
                for (SearchHit<Literature> literatureSearchHit : paperHits) {
                    paperInfo.append("**文献id：").append(literatureSearchHit.getContent().getId());
                    paperInfo.append("文献标题：").append(literatureSearchHit.getContent().getTitle());
                    paperInfo.append("文献摘要：").append(literatureSearchHit.getContent().getSummary()).append("**").append("\n");
                }

                String drugName = drugInfo.getDrugName();

                String paperSelectPrompt = PromptConstant.getPrompt(PromptConstant.PAPER_SELECT_PROMPT, drugName, drugName, drugName, drugName, paperInfo);
                String aiResult_paperSelect = retryUtils.executeWithRetry(paperSelectPrompt, String.class, "有效期模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                StringBuilder paperInfo1 = new StringBuilder();
                if (StringUtils.isNotBlank(aiResult_paperSelect)) {

                    for (SearchHit<Literature> literatureSearchHit : paperHits) {
                        String paperId = literatureSearchHit.getContent().getId();
                        if (aiResult_paperSelect.contains(paperId)) {
                            JSONObject inner = new JSONObject();
                            inner.put("title", HtmlUtil.cleanHtmlTag(literatureSearchHit.getContent().getTitle()));
                            paperInfo1.append("标题：").append(literatureSearchHit.getContent().getTitle());
                            inner.put("content", literatureSearchHit.getContent().getSummary());
                            paperInfo1.append("摘要：").append(literatureSearchHit.getContent().getSummary());
                            idMatchList.add(inner);
                        }
                    }

                    if (idMatchList.isEmpty()) {
                        trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber("0"));
                    } else {
                        String paperRatingPrompt = PromptConstant.getPrompt(PromptConstant.PAPER_RATING_PROMPT, drugName, drugName, paperInfo1);
                        String aiResult = retryUtils.executeWithRetry(paperRatingPrompt, String.class, "文献打分模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());
                        trMarketEvaluationDto.setEconomicAdvantageScore(extractLastNumber(aiResult));
                    }
                }
            } else {
                trMarketEvaluationDto.setEconomicAdvantageScore(0.0);
            }

//        writer.write("dailyTreatmentCostJson", jsonObject1, "日均治疗费用信息");
            writer.write("dailyTreatmentCostScore", trMarketEvaluationDto.getDailyTreatmentCostScore(), "日均治疗费用得分");
            writer.write("dailyTreatmentCostOption", "", "日均治疗费用选项");
            writer.write("economicAdvantageScore", trMarketEvaluationDto.getEconomicAdvantageScore(), "经济学优势得分");
            writer.write("economicAdvantageOption", idMatchList, "经济学优势内容");

            trMarketEvaluationDto.setEconomicScore();
            writer.write("economicScore", trMarketEvaluationDto.getEconomicScore(), "经济性总得分");

            // 国家基本药物
            String essentialMedicines = drugInfo.getEssentialMedicines();
            if (StringUtils.isNotEmpty(essentialMedicines) && "是".equals(essentialMedicines)) {
                trMarketEvaluationDto.setNationalEssentialDrugsScore(3.0);
                trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品被《国家基本药物目录》收载");
            } else {
                trMarketEvaluationDto.setNationalEssentialDrugsScore(0.0);
                trMarketEvaluationDto.setNationalEssentialDrugsRequirement("该药品未被《国家基本药物目录》收载");
            }
            writer.write("nationalEssentialDrugsRequirement", trMarketEvaluationDto.getNationalEssentialDrugsRequirement(), "国家基本药物");
            writer.write("nationalEssentialDrugsScore", trMarketEvaluationDto.getNationalEssentialDrugsScore(), "国家基本药物得分");

            // 医保
            boolean isInsurance = false;
            String medicalInsurance = drugInfo.getMedicalInsurance();
            if (StringUtils.isNotBlank(medicalInsurance)) {
                isInsurance = true;
            }

            String medicalInsuranceContent = "";
            // 医保得分
            double isInsuranceScore = 1.00F;
            if (isInsurance) {
                boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo.getPaymentScope());
                if ("甲".equals(medicalInsurance)) {
                    medicalInsuranceContent = "该药品属于医保甲类";
                    if (paymentScopeStatus) {
                        isInsuranceScore = 2.50F;
                        medicalInsuranceContent += "，有支付限制，" + drugInfo.getPaymentScope();
                    } else {
                        isInsuranceScore = 3.00F;
                        medicalInsuranceContent += "，无支付限制";
                    }
                } else {
                    medicalInsuranceContent = "该药品属于医乙类";
                    if (paymentScopeStatus) {
                        isInsuranceScore = 1.50F;
                        medicalInsuranceContent += "，有支付限制，" + drugInfo.getPaymentScope();
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

            writer.write("nationalMedicalInsuranceDrugsPaymentRequirement", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsPaymentRequirement(), "医保内容");
            writer.write("nationalMedicalInsuranceDrugsScore", trMarketEvaluationDto.getNationalMedicalInsuranceDrugsScore(), "医保得分");

            // 集采
            //是否得分
            boolean isConcentrate = true;

            String drugCollection = drugInfo.getDrugCollection();
            if ("不属于国家/联盟集中采购药品。".equals(drugCollection)) {
                isConcentrate = false;
            }

            String isTheAgreementForTheJudgment = drugInfo.getIsTheAgreementForTheJudgment();
            String termOfAgreement = drugInfo.getTermOfAgreement();
            if (StringUtils.isNotEmpty(isTheAgreementForTheJudgment)|| StringUtils.isNotEmpty(termOfAgreement)) {
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

            writer.write("centralizedVolumePurchasingDrugsScore", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsScore(), "国家集采");
            writer.write("centralizedVolumePurchasingDrugsSource", trMarketEvaluationDto.getCentralizedVolumePurchasingDrugsSource(), "国家集采内容");

            String drugName = drugInfo.getDrugName();
            String manufacturer = drugInfo.getManufacturer();
            String ingredient = drugInfo.getIngredient();

            // 处理生产企业情况评分结果
            Map<String, String> resField = new HashMap<>();
            resField.put("score", "打分（务必是数字:int或者double类型）");
            resField.put("content", "打分的相关依据");
            JSONObject properties = new JSONObject();
            properties.putAll(resField);
            String productionEnterprisePrompt = PromptConstant.getPrompt(PromptConstant.PRODUCTION_ENTERPRISE_STATUS_PROMPT, drugName, manufacturer, JSON.toJSONString(properties));
            JSONObject aiResult = retryUtils.executeWithRetry(productionEnterprisePrompt, JSONObject.class, "生产企业模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            if (StringUtils.isNotEmpty(drugInfoUtil.qiyeScore(drugInfo.getManufacturer()))){
                aiResult.put("score", drugInfoUtil.qiyeScore(drugInfo.getManufacturer()));
            }
            writer.write("productionEnterpriseScore", extractLastNumber(aiResult.getString("score")), "企业排名得分");
            writer.write("productionEnterpriseContent", aiResult.getString("content"), "企业排名内容");


            // 处理生产企业GAP种植基地判断结果
            // 处理生产企业情况评分结果
            resField = new HashMap<>();
            resField.put("score", "打分（务必是数字:int或者double类型）");
            resField.put("content", "打分的相关依据");
            properties = new JSONObject();
            properties.putAll(resField);
            String productionEnterpriseXPrompt = PromptConstant.getPrompt(PromptConstant.PRODUCTION_ENTERPRISE_STATUS_PROMPTX, drugName, manufacturer, ingredient, JSON.toJSONString(properties));
            JSONObject aiResult_X = retryUtils.executeWithRetry(productionEnterpriseXPrompt, JSONObject.class, "模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

            writer.write("ownPlantingBaseScore", extractLastNumber(aiResult_X.getString("score")), "是否有独立的培植基地得分");
            writer.write("ownPlantingBaseOption", aiResult_X.getString("content"), "是否有独立的培植基地内容");

            writer.write("productionEnterpriseStatusScore", Double.parseDouble(aiResult.getString("score")) + Double.parseDouble(aiResult_X.getString("score")), "企业状况得分");
            trMarketEvaluationDto.setPolicyAttributeScore();

            writer.write("policyAttributeScore", trMarketEvaluationDto.getPolicyAttributeScore(), "政策属性总得分");
            trMarketEvaluationDto.setTotalScore();
            writer.write("marketEvaluationTotalScore", trMarketEvaluationDto.getTotalScore() + Double.parseDouble(aiResult.getString("score")) + Double.parseDouble(aiResult_X.getString("score")), "市场评价总得分");

            return trMarketEvaluationDto.getTotalScore();
        });

        //********************************  第四阶段：最终汇总  ****************************************//
        CompletableFuture<Void> allPartFuture = CompletableFuture.allOf(
                onePartFuture,
                twoPartFuture,
                threePartFuture,
                fourPartFuture,
                fivePartFuture
        );

        // 🔥 等待所有任务完成
        try {
            allPartFuture.get(500, TimeUnit.SECONDS);
            log.info("报告所有模块完成，花费时间{}", new Date().getTime() - concurrenceData.getTime());
        } catch (Exception e) {
            log.error("任务执行异常", e);
        } finally {
            writer.write("end", drugInfo.getDrugName(),"end");
            // 等待最多5秒让所有结果输出，然后停止调度器
            writer.waitForCompletionAndStop(100, TimeUnit.SECONDS);
            try {
                Thread.sleep(5000);
            } catch (InterruptedException e) {
                log.error("所有任务完成，等待 5秒 处执行异常", e);
            }
            scheduler.shutdown();
        }
        
        TrInfoDto trInfoDto = new TrInfoDto(null, trInheritanceEvaluationDto, trClinicalEvaluationDto, trSafetyEvaluationDto, trPolicyEvaluationDto, trMarketEvaluationDto, 0.0, drugInfo.getDrugName(), drugId, title,null);
        mongoTemplate.save(trInfoDto);
        log.info("中成药报告已完成，trInfoDto:{}",  JSONUtil.toJsonStr(trInfoDto));
        
        addScore(trInfoDto);
        TrInfoAppVo trInfoAppVo = new TrInfoAppVo();
        trInfoAppVo.setDrugName(drugInfo.getDrugName());
        trInfoAppVo.setId(id);
        trInfoAppVo.setDrugId(drugId);
        trInfoAppVo.setTitle(title);
        trInfoAppVo.setTotalScore(trInfoDto.getTotalScore());
        trInfoAppVo.setTrInheritanceEvaluationScore(trInfoDto.getTrInheritanceEvaluationDto().getTotalScore());
        trInfoAppVo.setTrClinicalEvaluationScore(trInfoDto.getTrClinicalEvaluationDto().getTotalScore());
        trInfoAppVo.setTrSafetyEvaluationScore(trInfoDto.getTrSafetyEvaluationDto().getTotalScore());
        trInfoAppVo.setTrTechnologyEvaluationScore(trInfoDto.getTrTechnologyEvaluationDto().getTotalScore());
        trInfoAppVo.setTrMarketEvaluationScore(trInfoDto.getTrMarketEvaluationDto().getTotalScore());

        JSONObject jsonObject2 = new JSONObject();
        jsonObject2.put("title", title);
        jsonObject2.put("info", cacheDtos);
        mongoTemplate.save(jsonObject2, "evaluation_tr_cache");

        String drugName = drugInfo.getDrugName();
        JSONObject jsonObject = (JSONObject) JSONObject.toJSON(trInfoDto);
        jsonObject.put("reportId", id);
        jsonObject.getJSONObject("trInheritanceEvaluationDto").put("trInheritanceEvaluationScore", drugName + "在传承评价的得分为：" + trInfoDto.getTrInheritanceEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trClinicalEvaluationDto").put("trClinicalEvaluationScore", drugName + "在临床评价的得分为：" + trInfoDto.getTrClinicalEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trSafetyEvaluationDto").put("trSafetyEvaluationScore", drugName + "在安全性评价的得分为：" + trInfoDto.getTrSafetyEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trTechnologyEvaluationDto").put("trTechnologyEvaluationScore", drugName + "在技术评价的得分为：" + trInfoDto.getTrTechnologyEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trMarketEvaluationDto").put("trMarketEvaluationScore", drugName + "在市场评价的得分为：" + trInfoDto.getTrMarketEvaluationDto().getTotalScore() + "分");
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        Date date = new Date();
        String format = simpleDateFormat.format(date);
        jsonObject.put("time", format);
        jsonObject.put("simpleTitle", drugName + "药品综合评价报告");
        trInfoAppVo.setReportId(id);
        return jsonObject2;
    }
    private String getTxt(DrugInfoNew drugInfo, String searchText, String s) {
        try {
            String drugName = drugInfo.getDrugName();
            Set<String> drugs = new HashSet<>(drugInfo.getDrugSynonymZh());
            drugs.add(drugInfo.getDrugZh());

            // 定义搜索阶段
            List<String[]> searchStages = Arrays.asList(
                    new String[]{"标题", "标题"},           
                    new String[]{"标题", "文本块副本"},     
                    new String[]{"文本块副本", "标题"},     
                    new String[]{"文本块副本", "文本块副本"}, 
                    new String[]{"", ""} 
            );

            List<SearchHit<GuideIndex>> searchHits = Collections.emptyList();
            for (String[] stage : searchStages) {
                String drugField = stage[0];
                String diseaseField = stage[1];

                searchHits = performSingleSearch(drugInfo, s, drugField, diseaseField, elasticsearchRestTemplate);

                if (!searchHits.isEmpty()) {
                    // 如果当前阶段有结果，返回结果
                    break;
                }
                // 如果当前阶段没有结果，继续下一阶段
            }
            
            if (CollectionUtils.isNotEmpty(searchHits)) {
                StringBuilder gptTxt = new StringBuilder();
                for (SearchHit<GuideIndex> searchHit : searchHits) {
                    GuideIndex guide = searchHit.getContent();
                    StringBuilder innerBuilder = new StringBuilder();
                    innerBuilder.append("标题：").append(guide.getTitle()).append("\n");
                    innerBuilder.append("发布机构：").append(guide.getZdz()).append("\n");
                    innerBuilder.append("内容：").append(guide.getPdf_txt()).append("\n");

                    int length = innerBuilder.length();
                    if (innerBuilder.length() > 10000) {
                        gptTxt.append(innerBuilder.substring(0, 10000)).append("######\n");
                    }
                }
                if (gptTxt.length() > 200000) {
                    gptTxt = new StringBuilder(gptTxt.substring(0, 200000));
                }

                Map<String, String> resField = new HashMap<>();
                resField.put("content", "请在给定内容中总结输出关于"+ drugName + "在" + searchText + "方面的内容。（如果没有相关内容请严格返回空字符串''）");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String informationExtractionPrompt = PromptConstant.getPrompt(PromptConstant.INFORMATION_EXTRACTION_PROMPT, drugName, searchText, drugName, searchText, drugName, searchText, JSON.toJSONString(properties), gptTxt);
                JSONObject aiResult = retryUtils.executeWithRetry(informationExtractionPrompt, JSONObject.class, "指南提取患者人群内容模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String content = aiResult.getString("content");

                if (StringUtils.isNotEmpty(content)) {
                    return content;
                } 
            }


            BoolQueryBuilder paperQuery = new BoolQueryBuilder();
            StringBuilder query = new StringBuilder();

            BoolQueryBuilder bool = new BoolQueryBuilder();
            QueryUtils.montageForCustomizeName(query, new ArrayList<>(drugs), "标题", "OR");
            BoolQueryBuilder drugInTitle = new SearchFormula().execute(query.toString(), 1, 1, 0);
            paperQuery.must().add(drugInTitle);

            query = new StringBuilder();
            QueryUtils.montageForCustomizeName(query, Arrays.asList(s), "摘要", "OR");
            BoolQueryBuilder searchTextInSummary = new SearchFormula().execute(query.toString(), 1, 1, 0);
            bool.should().add(searchTextInSummary);

            query = new StringBuilder();
            QueryUtils.montageForCustomizeName(query, Arrays.asList(s), "简介", "OR");
            BoolQueryBuilder searchTextInNrjs = new SearchFormula().execute(query.toString(), 1, 1, 0);
            bool.should().add(searchTextInNrjs);
            
            paperQuery.must().add(bool);
            // 构建脚本评分函数
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(paperQuery);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

            SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            List<SearchHit<Literature>> searchHits1 = literatureSearchHits.getSearchHits();
            
            StringBuilder gptTxt1 = new StringBuilder();
            
            for (SearchHit<Literature> literatureSearchHit : searchHits1) {
                gptTxt1.append("标题：").append(literatureSearchHit.getContent().getTitle()).append("\n");
                gptTxt1.append("摘要：").append(literatureSearchHit.getContent().getSummary()).append("\n");
                gptTxt1.append("内容：").append(literatureSearchHit.getContent().getTldr()).append("\n");
                gptTxt1.append("作者：").append(literatureSearchHit.getContent().getAuthor()).append("\n");
            }
            if (gptTxt1.length() > 200000) {
                gptTxt1 = new StringBuilder(gptTxt1.substring(0, 200000));
            }

            if (StringUtils.isNotBlank(gptTxt1)) {
                Map<String, String> resField = new HashMap<>();
                resField.put("content", "输出内容");
                JSONObject properties = new JSONObject();
                properties.putAll(resField);
                String pregnancyPrompt = PromptConstant.getPrompt(PromptConstant.PAPER_INFORMATION_EXTRACTION_PROMPT, drugName, searchText, drugName, searchText, JSON.toJSONString(properties), gptTxt1);
                JSONObject aiResult = retryUtils.executeWithRetry(pregnancyPrompt, JSONObject.class, "儿童用药模型分析", PriorityConstants.PRIORITY_CRITICAL, GptDemoEnum.GPT_DEMO_1.getContent());

                String content = aiResult.getString("content");

                if (StringUtils.isNotEmpty(content)) {
                    if (content.length() > 10000) {
                        content = content.substring(0, 10000);
                    }
                    return content;
                }
            }
        } catch (Exception e) {
            log.error("获取特殊人群用法异常", e);
        }
        return "";
    }
    private List<SearchHit<GuideIndex>> performSingleSearch(DrugInfoNew drugInfo, String s, String drugField, String diseaseField, ElasticsearchRestTemplate elasticsearchRestTemplate) {
        Set<String> drugs = new HashSet<>(drugInfo.getDrugSynonymZh());
        drugs.add(drugInfo.getDrugZh());

        BoolQueryBuilder guideQuery = new BoolQueryBuilder();
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
        guideQuery.must().add(QueryBuilders.termsQuery("isPaper", "0", "1"));

        // 药物查询
        StringBuilder drugQuery = new StringBuilder();
        QueryUtils.montageForCustomizeName(drugQuery, new ArrayList<>(drugs), drugField, "OR");
        BoolQueryBuilder drugBool = new SearchFormula().execute(drugQuery.toString(), 2, 1, 0);
        guideQuery.must().add(drugBool);

        // 疾病查询
        StringBuilder diseaseQuery = new StringBuilder();
        QueryUtils.montageForCustomizeName(diseaseQuery, Arrays.asList(s), diseaseField, "OR");
        BoolQueryBuilder diseaseBool = new SearchFormula().execute(diseaseQuery.toString(), 2, 1, 0);
        guideQuery.must().add(diseaseBool);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        nativeSearchQuery.setMaxResults(30);

        SearchHits<GuideIndex> guideHits = null;
        try {
            guideHits = RetryUtils.retry(
                    () -> elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class),
                    3,
                    1000,  // 每次重试间隔1秒
                    e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
            );
            // 使用guideHits做后续处理
        } catch (Exception e) {
            log.error("Search operation failed after retries", e);
            // 这里可以做失败后降级或补偿逻辑
        }
        if (guideHits == null) return Collections.emptyList();
        return guideHits.getSearchHits();
    }
    private SearchHits<Literature> performSearch(String drugName, Set<String> drugs, List<Integer> types) {
        BoolQueryBuilder paperQuery = new BoolQueryBuilder();

        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();

        StringBuilder query = new StringBuilder();
        QueryUtils.montage(query, drugs);
        //检索式拼接条件
        String formula = new SearchFormula().execute(query.toString(), 1, 1, 0).toString();
        boolQuery.must().add(QueryBuilders.wrapperQuery(formula));

        paperQuery.must().add(boolQuery);

        // 添加类型查询条件
        if (types.size() == 1) {
            paperQuery.must().add(QueryBuilders.termQuery("lastNewType", types.get(0)));
        } else {
            paperQuery.must().add(QueryBuilders.termsQuery("lastNewType", types));
        }

        // 构建脚本评分函数
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = buildScoreFunctions();

        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(paperQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.MULTIPLY);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.setMaxResults(10);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        SearchHits<Literature> searchResult = null;
        try {
            searchResult = RetryUtils.retry(
                    () -> elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class),
                    5,
                    1000,
                    e -> true
            );
        } catch (Exception e) {
            log.error("文献证据，尝试三次查询错误");
        }       
        return searchResult;
    }
    private FunctionScoreQueryBuilder.FilterFunctionBuilder[] buildScoreFunctions() {
        String scriptStr = "def baseScore = Math.log1p(_score + 1) * 0.5; return baseScore;";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);

        String incompleteScriptStr = "if(doc['isIncomplete'].size() > 0 && doc['isIncomplete'].value == 1) { " +
                "  return 0.1; " +
                "} else { " +
                "  return 1.0; " +
                "}";
        Script incompleteScript = new Script(incompleteScriptStr);
        ScriptScoreFunctionBuilder incompleteScriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(incompleteScript);

        String languageScriptStr = "if(doc['language'].size() > 0 && doc['language'].value == 'zh') { " +
                "  return 0.7; " +
                "} else { " +
                "  return 1.0; " +
                "}";
        Script languageScript = new Script(languageScriptStr);
        ScriptScoreFunctionBuilder languageScriptFunction = new ScriptScoreFunctionBuilder(languageScript);

        String lastNewTypeScriptStr = "if(doc['lastNewType'].size() > 0) { " +
                "  for(int i = 0; i < doc['lastNewType'].length; i++) { " +
                "    def value = doc['lastNewType'][i]; " +
                "    int intValue = Integer.parseInt(value.toString()); " +
                "    if(intValue == 0 || intValue == 2 || intValue == 3) { " +
                "      return 2; " +
                "    } " +
                "  } " +
                "  return 1; " +
                "} else { " +
                "  return 1; " +
                "}";
        Script lastNewTypeScript = new Script(lastNewTypeScriptStr);
        ScriptScoreFunctionBuilder lastNewTypeScriptFunction = new ScriptScoreFunctionBuilder(lastNewTypeScript);

        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[4];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(incompleteScriptScoreFunctionBuilder);
        filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(languageScriptFunction);
        filterFunctionBuilders[3] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(lastNewTypeScriptFunction);

        return filterFunctionBuilders;
    }
    private void processSearchResults(SearchHits<Literature> searchResult,
                                      TrClinicalEvaluationDto trClinicalEvaluationDto,
                                      List<JSONObject> evidenceItems,
                                      double score) {
        String string = "";
        int count = 1;

        for (SearchHit<Literature> literatureSearchHit : searchResult) {
            String title = literatureSearchHit.getContent().getTitle();
            String summary = literatureSearchHit.getContent().getSummary();
            string += "(" + count + ")" + title + "\n";
            string += (StringUtils.isNotEmpty(summary) ? summary : "") + "\n";

            JSONObject evidenceItem = new JSONObject();
            evidenceItem.put("title", HtmlUtil.cleanHtmlTag(title));
            evidenceItem.put("content", summary);
            evidenceItems.add(evidenceItem);
            count++;
        }

        trClinicalEvaluationDto.setClinicalResearchContent(string);
        trClinicalEvaluationDto.setClinicalResearchScore(score);
    }
    private void assembleGuide(String guideTitle, String guideId, List<String> guideList, List<JSONObject> guideDtoList, String medicine, List<String> drugSynonym, JSONObject guideInfo, AtomicInteger successCount, AtomicBoolean shouldStop) {
        // 早期检查，如果已经达到限制就直接返回
        if (shouldStop.get() || successCount.get() >= 5) {
            return;
        }

        BoolQueryBuilder guideBlockSearchBool = new BoolQueryBuilder();

        TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("guideId", guideId);
        guideBlockSearchBool.must().add(termQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideBlockSearchBool);
        nativeSearchQuery.setMaxResults(200);
        SearchHits<GuideBlockIndex> guideBlockIndexSearchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideBlockIndex.class);
        List<SearchHit<GuideBlockIndex>> searchHits = guideBlockIndexSearchHits.getSearchHits();

        if (CollUtil.isEmpty(searchHits))  {
            return;
        }

        drugSynonym.add(medicine);

        StringBuilder doubleBuilder = new StringBuilder();

        for (SearchHit<GuideBlockIndex> searchHit : searchHits) {
            // 再次检查是否应该停止
            if (shouldStop.get()) {
                return;
            }

            String block = searchHit.getContent().getBlock();
            if (block.length() > 2000) {
                block = block.substring(0, 2000);
            }

            if (checkFullWordContain(block, drugSynonym)) {
                doubleBuilder.append(block);
//                continue;
            }
        }

        if (StringUtils.isNotBlank(doubleBuilder)) {

            Map<String, String> resCusField = new HashMap<>();
            resCusField.put("score", "指南评分");
            resCusField.put("explanation", "简要说明评分关键点");

            JSONObject properties = new JSONObject();
            properties.putAll(resCusField);

            String guideComplete = "指南标题为：" + guideTitle + "指南文本内容为：" + doubleBuilder;
            String guideScorePrompt = PromptConstant.getPrompt(PromptConstant.GUIDE_SCORE_PROMPT, JSON.toJSONString(properties), medicine, guideComplete);
            JSONObject aiResult = retryUtils.executeWithRetryNew(guideScorePrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "指南文本打分", PriorityConstants.PRIORITY_CRITICAL, true);

            JSONObject guideEntity = new JSONObject();
            guideEntity.put("id", guideId);
            guideEntity.put("score", aiResult.getString("score"));

            resCusField = new HashMap<>();
            resCusField.put("summary", "精准总结（350-400字）");
            resCusField.put("relevance", "boolean");
            resCusField.put("evidence_level", "A/B/C/D（循证医学证据等级）");
            resCusField.put("key_evidence", "[\"具体证据点1\", \"具体证据点2\"]");

            properties = new JSONObject();
            properties.putAll(resCusField);

            String guideSummaryPrompt = PromptConstant.getPrompt(PromptConstant.GUIDE_SUMMARY_PROMPT, medicine, JSON.toJSONString(properties), medicine, doubleBuilder);
            JSONObject aiSummaryResult = retryUtils.executeWithRetry(guideSummaryPrompt, JSONObject.class, "指南文本总结", PriorityConstants.PRIORITY_CRITICAL, "");
            String summary = aiSummaryResult.getString("summary");
            guideEntity.put("content", summary);
            String title = guideInfo.getString("title") + "-" + guideInfo.getString("zdz") + "-" + guideInfo.getString("fbdate");
            guideEntity.put("title", title);
            guideDtoList.add(guideEntity);

            // 使用同步块确保线程安全
            synchronized (guideList) {
                // 双重检查，确保不会超过限制
                if (successCount.get() < 5 && !shouldStop.get()) {
                    doubleBuilder.insert(0, "该篇指南标题为：" + guideTitle + "指南文本内容为：");
                    guideList.add(doubleBuilder.toString());

                    int currentCount = successCount.incrementAndGet();
                    if (currentCount >= 5) {
                        shouldStop.set(true);
                        log.info("已达到指南数量限制(5个)，停止处理更多指南");
                    }
                }
            }
        }
    }
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    /**
     * 优雅关闭线程池
     */
    private void shutdownExecutorGracefully(ExecutorService executor, String name) {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
                log.warn("{}线程池未能在30秒内正常关闭，强制关闭", name);
                executor.shutdownNow();
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.error("{}线程池强制关闭失败", name);
                }
            } else {
                log.info("{}线程池已正常关闭", name);
            }
        } catch (InterruptedException e) {
            log.warn("等待{}线程池关闭时被中断，强制关闭", name);
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
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

    /**
     * 将得分格式化
     *
     * @param score dpt计算得分
     * @return 格式化后的得分
     */
    private String formatScore(String score) {
        //(1) 得分为整数的，直接显示分值，数值后不需要.00。如15;
        //(2) 得分为非整数的，请保留小数点后两位有效数字。
        double number = 0;
        try {
            number = Double.parseDouble(score);
        } catch (Exception e) {
            log.error("得分格式化异常", e);
            if (StringUtils.isEmpty(score)) {
                return "0";
            }
            number = extractLastNumber(score);

            log.info("得分格式化异常纠正为{}", number);
        }

        if (number % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(number);
        } else {
            return new DecimalFormat("#.##").format(number);
        }
    }

    private double extractLastNumber(String score) {
        if (StringUtils.isEmpty(score)){
            return 0;
        }
        // 查找“分”字之前的最后一个数字
        Pattern patternBeforeFen = Pattern.compile("-?\\d+(\\.\\d+)?(?=.*分)");
        Matcher matcherBeforeFen = patternBeforeFen.matcher(score);
        String lastMatchBeforeFen = null;

        while (matcherBeforeFen.find()) {
            lastMatchBeforeFen = matcherBeforeFen.group();
        }

        if (lastMatchBeforeFen != null) {
            try {
                return Double.parseDouble(lastMatchBeforeFen);
            } catch (NumberFormatException e) {
                log.error("无法解析“分”字之前的最后一个数字", e);
            }
        }

        // 如果没有找到“分”字之前的数字，则查找字符串的最后一个数字（不支持负数）
        Pattern pattern = Pattern.compile("\\d+(\\.\\d+)?");
        Matcher matcher = pattern.matcher(score);
        String lastMatch = null;

        while (matcher.find()) {
            lastMatch = matcher.group();
        }

        if (lastMatch != null) {
            try {
                return Double.parseDouble(lastMatch);
            } catch (NumberFormatException e) {
                log.error("无法解析最后一个数字", e);
            }
        }

        // 如果没有找到有效的数字，返回0.0
        return 0.0;
    }
    
    private int pharmacyAnalysis(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, List<CacheDto> stringBuilder, HttpServletResponse response) {
        JSONObject pharmaceuticalCharacteristics = new JSONObject();
        result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
        pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
        pharmaceuticalCharacteristics.put("table", new JSONArray().fluentAdd(new ArrayList<>(Arrays.asList("序号", "评价条目", "相关内容", "得分"))));
        pharmaceuticalCharacteristics.put("score", 0);
        pharmaceuticalCharacteristics.put("vscore", 0);


//        addProcess(id, step++, "<b>1、药学特性</b>", stringBuilder);
//        addProcess(id, step++, "主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。", stringBuilder);
        // 1.药理作用
        long begin_pharmacology = System.currentTimeMillis();
        JSONObject pharmacology = new JSONObject();
        try {
            boolean has = false;
            if (StringUtils.isNotBlank(drugInfo.getPharmacology())) {
                String key = SecurityUtil.getMd5(drugName + "pharmacology");
                String gptRedis = getGptRedis(key);
                if (StringUtils.isNotEmpty(gptRedis)) {
                    pharmacology = JSONObject.parseObject(gptRedis);
                    has = true;
                }
            }
            if (!has) {
                pharmacology = lxGptService.pharmacology(drugName, disease, drugInfo);
                if (StringUtils.isNotBlank(drugInfo.getPharmacology())) {
                    String key = GPT_REDIS_KEY + SecurityUtil.getMd5(drugName + "pharmacology");
                    redisTemplate.opsForValue().set(key, pharmacology.toJSONString(), 24, TimeUnit.HOURS);
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (pharmacology.getString("score") == null) {
                pharmacology.put("score", 0);
                write("pharmacologyScore", 0, response, stringBuilder,"药理作用");
            } else {
                write("pharmacologyScore", pharmacology.getString("score"), response, stringBuilder,"药理作用");
            }
            if (StringUtils.isNotEmpty(drugInfo.getPharmacology())) {
                pharmacology.put("process", drugInfo.getPharmacology());
                write("pharmacology", drugInfo.getPharmacology(), response, stringBuilder,"药理作用");
            } else if (pharmacology.getString("process") == null) {
                pharmacology.put("process", pharmacology.getString("process"));
                write("pharmacology", pharmacology.getString("process"), response, stringBuilder,"药理作用");
            } else {
                write("pharmacology", pharmacology.getString("process"), response, stringBuilder,"药理作用");
            }

        }
        log.info("pharmacology  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacology
        );

//        addProcess(id, step++, "（1）药理作用：", stringBuilder);
////        if (Objects.nonNull(drugInfo) && StringUtils.isNotBlank(drugInfo.getPharmacology())) {
////            addProcess(id,step ++,formatInfo(drugInfo.getPharmacology()));
////        } else {
////            addProcess(id,step ++,formatInfo(pharmacology.getString("process")));
////        }
//        addProcess(id, step++, formatInfo(pharmacology.getString("process")), stringBuilder);

        // 2.体内过程
        long begin_pharmacokinetics = System.currentTimeMillis();
        JSONObject pharmacokinetics = new JSONObject();
        try {
            boolean has = false;
            if (drugInfo.getHasPharmacokinetics()) {
                String key = SecurityUtil.getMd5(drugName + "");
                String gptRedis = getGptRedis(key);
                if (StringUtils.isNotEmpty(gptRedis)) {
                    pharmacokinetics = JSONObject.parseObject(gptRedis);
                    has = true;
                }
            }
            if (!has) {
                pharmacokinetics = lxGptService.pharmacokinetics(drugName, disease, drugInfo);
                if (drugInfo.getHasPharmacokinetics()) {
                    String key = GPT_REDIS_KEY + SecurityUtil.getMd5(drugName + "pharmacokinetics");
                    redisTemplate.opsForValue().set(key, pharmacokinetics.toJSONString(), 24, TimeUnit.HOURS);
                }
            }

        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (pharmacokinetics.getString("score") == null) {
                pharmacokinetics.put("score", 0);
                write("pharmacokineticsScore", 0, response, stringBuilder,"体内过程");
            } else {
                write("pharmacokineticsScore", pharmacokinetics.getString("score"), response, stringBuilder,"体内过程");
            }
            if (pharmacokinetics.getString("process") == null) {
                pharmacokinetics.put("process", "");
                write("pharmacokinetics", pharmacokinetics.getString("process"), response, stringBuilder,"体内过程");

            } else if (StringUtils.isNotEmpty(drugInfo.getPharmacokinetics())) {
                pharmacokinetics.put("process", drugInfo.getPharmacokinetics());
                write("pharmacokinetics", pharmacokinetics.getString("process"), response, stringBuilder,"体内过程");
            } else {
                write("pharmacokinetics", pharmacokinetics.getString("process"), response, stringBuilder,"体内过程");
            }
        }
        log.info("pharmacokinetics  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacokinetics);

//        addProcess(id, step++, "（2）体内过程：", stringBuilder);
////        if (Objects.nonNull(drugInfo) && StringUtils.isNotBlank(drugInfo.getPharmacokinetics())) {
////            addProcess(id,step ++,formatInfo(drugInfo.getPharmacokinetics()));
////        } else {
////            addProcess(id,step ++,formatInfo(pharmacokinetics.getString("process")));
////        }
//        addProcess(id, step++, formatInfo(pharmacokinetics.getString("process")), stringBuilder);


        // 3.药剂学和使用方法
        long begin_usageAndDosage = System.currentTimeMillis();

        try {


        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {

//            String process = usageAndDosage.getString("process");
//            process = process.replaceFirst("\\{", "");
//            process = process.replaceFirst("}", "");
//            process = process.replaceFirst("\\[", "");
//            process = process.replaceFirst("]", "");
//            usageAndDosage.put("process", process);
        }
//        log.info("usageAndDosage  gpt  分析时长{}", System.currentTimeMillis() - begin_usageAndDosage);
//
//        addProcess(id, step++, "（3）药剂学与使用方法：", stringBuilder);
        String ingredient = drugInfo.getIngredient();
        if (StringUtils.isNotEmpty(ingredient)) {
            ingredient = ingredient.replaceAll("\\n$", "");
            ingredient = ingredient.replaceAll("化学结构式:", "");
        } else {
            ingredient = "";
        }
        if (StringUtils.isEmpty(drugInfo.getSpecifications())) {
            drugInfo.setSpecifications("");
        }
        if (StringUtils.isEmpty(drugInfo.getPack())) {
            drugInfo.setPack("");
        }
        String sp = drugInfo.getSpecifications() + drugInfo.getPack();
        if (StringUtils.isNotEmpty(sp)) {
            sp = sp.replaceAll("\\n$", "");
        } else {
            sp = "";
        }

        String dosageForm = drugInfo.getDosageForm();
        if (StringUtils.isNotEmpty(dosageForm)) {
            dosageForm = dosageForm.replaceAll("\\n$", "");
        } else {
            dosageForm = "";
        }
        String usag = drugInfo.getUsageAndDosage();
        if (StringUtils.isNotEmpty(usag)) {
            usag = usag.replaceAll("\\n$", "");
        } else {
            usag = "";
        }


        float pharmacyAnalysisScore = 0f;

        JSONObject usageAndDosage = new JSONObject();

        String promptA = "请分析一下" + drugName + "的主要成分与辅料是否明确，需要根据提供的成分信息进行真实描述，不要猜测结果。相关成分信息：" + drugInfo.getIngredient() + ";" +
                "并根据以下评分规则给予一个得分，单选：" +
                "2分：主要成分与辅料均明确。" +
                "1分：主要成分明确或辅料明确。";

        HashMap<String, String> stringStringHashMap5 = new HashMap<>();
        stringStringHashMap5.put("processA", "主要成分与辅料是否明确");
        stringStringHashMap5.put("scoreA", "打分（务必是数字:int或者double类型）");
        JSONObject responseFormat5 = getResponseFormat(stringStringHashMap5);

        JSONObject jsonObject6 = new JSONObject();
        if (!isNew){
             jsonObject6 = lxGptService.executeGptPlus(promptA, "pharmacology", responseFormat5, "","2,1");

        }else {
             jsonObject6 = gptAiUtils.executeGptPlus(promptA, "pharmacology", getDemo("processA", "scoreA"), "", "2,1");

        }


        String scoreA = jsonObject6.getString("scoreA");
        String processA = jsonObject6.getString("processA");

        usageAndDosage.put("scoreA", extractLastNumber(scoreA));
        usageAndDosage.put("processA", processA);


        if (StringUtils.isNotEmpty(ingredient) && ingredient.contains("辅料")) {
            write("componentScore", 2, response, stringBuilder,"成分");
        } else {
            write("componentScore", formatScore(usageAndDosage.getString("scoreA")), response, stringBuilder,"成分");
        }
        if (StringUtils.isNotEmpty(ingredient)){
            write("component", ingredient, response, stringBuilder,"成分");
        } else {
            write("component", processA, response, stringBuilder,"成分");
        }



        //包装
        String promptB = "请你作为一名专业的西药临床药师，根据说明书中药品规格、包装与用法用量信息，分析一下" + drugName + "的规格与包装是否适宜临床使用，或者是否方便临床上进行剂量调整，并结合以下评分规则给予一个得分，单选：" +
                "返回参数scoreB（打分）和processB（原因）" +
                "2分：规格适宜临床应用或者剂量调整，且包装适宜临床应用或者剂量调整。" +
                "1分：规格适宜临床应用或者剂量调整，或者包装适宜临床应用或者剂量调整。" +
                "药品规格信息" + drugInfo.getSpecifications() + ";" + "包装信息:" + drugInfo.getPack() + "药品用法用量信息" + drugInfo.getSpecifications();

        HashMap<String, String> stringStringHashMap4 = new HashMap<>();
        stringStringHashMap4.put("scoreB", "包装分数（只能是阿拉伯数字组成）");
        stringStringHashMap4.put("processB", "包装得分原因");

        JSONObject jsonObject4 = new JSONObject();
        if (!isNew){
            jsonObject4 = lxGptService.executeGptPlus(promptB, "package", getResponseFormat(stringStringHashMap4), "","2,1");
        }else {
            jsonObject4 = gptAiUtils.executeGptPlus(promptB, "package", getDemo("processB", "scoreB"), "","2,1");
        }



        String processB = jsonObject4.getString("processB");
        String scoreB = jsonObject4.getString("scoreB");

        usageAndDosage.put("processB", processB);
        usageAndDosage.put("scoreB", extractLastNumber(scoreB));

        write("packageScore", formatScore(usageAndDosage.getString("scoreB")), response, stringBuilder,"成分");
        write("package", usageAndDosage.getString("processB"), response, stringBuilder,"成分");

        //剂型
        String promptC = "请分析一下" + drugName + "的剂型是什么，" + "剂型信息：" + drugInfo.getDosageForm() + "，" +
                "并根据以下评分规则给予一个得分（注意：若药品存在多个给药途径时，分值采用就高原则）：" +
                "返回参数scoreC（打分）和processC（原因）" +
                "2分：口服制剂/吸入制剂/外用制剂。" +
                "1.5分：皮下注射剂/肌内注射剂。" +
                "1分：静脉滴注/静脉注射剂。\n";

        HashMap<String, String> stringStringHashMap3 = new HashMap<>();
        stringStringHashMap3.put("scoreC", "剂型分数（只能是阿拉伯数字组成）");
        stringStringHashMap3.put("processC", "剂型得分原因");

        JSONObject dosageFormResult = new JSONObject();
        if (!isNew){
            dosageFormResult = lxGptService.executeGptPlus(promptC, "剂型", getResponseFormat(stringStringHashMap3), "","2,1.5,1");
        }else {
            dosageFormResult = gptAiUtils.executeGptPlus(promptC, "剂型", getDemo("processC", "scoreC"), "","2,1.5,1");
        }


        String dosageFormResultContent = dosageFormResult.getString("processC");
        String scoreC = dosageFormResult.getString("scoreC");

        usageAndDosage.put("processC", dosageFormResultContent);
        usageAndDosage.put("scoreC", extractLastNumber(scoreC));


        write("dosageFormScore", formatScore(usageAndDosage.getString("scoreC")), response, stringBuilder,"剂型");
        write("dosageForm", usageAndDosage.getString("processC"), response, stringBuilder,"剂型");

        //固定计量
        String promptD = "请分析一下" + drugName + "在治疗" + disease + "时的给药剂量，是固定给药剂量，还是需要根据体质量或体表面积计算后调整给药剂量，" +
                "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                "并根据以下评分规则给予一个得分，单选：" +
                "返回参数scoreD（打分）和processD（原因）" +
                "2分：给药剂量固定。" +
                "1.5分：使用过程中需调整给药剂量。" +
                "1分：根据体质量或体表面积计算用药剂量。";
        HashMap<String, String> stringStringHashMap2 = new HashMap<>();
        stringStringHashMap2.put("scoreD", "给药剂量分数（只能是阿拉伯数字组成）");
        stringStringHashMap2.put("processD", "给药剂量原因");
        JSONObject responseFormat2 = getResponseFormat(stringStringHashMap2);

        JSONObject jsonObject2 = new JSONObject();
        if (!isNew){
            jsonObject2 = lxGptService.executeGptPlus(promptD, "dose", getResponseFormat(stringStringHashMap2), "","2,1.5,1");
        }else {
            jsonObject2 = gptAiUtils.executeGptPlus(promptD, "dose", getDemo("processD", "scoreD"), "","2,1.5,1");
        }


        String processD = jsonObject2.getString("processD");
        String scoreD = jsonObject2.getString("scoreD");
        usageAndDosage.put("processD", processD);
        usageAndDosage.put("scoreD", extractLastNumber(scoreD));


        write("doseScore", formatScore(usageAndDosage.getString("scoreD")), response, stringBuilder,"固定计量");
        write("dose", usageAndDosage.getString("processD"), response, stringBuilder,"固定计量");


        //  给药频次
        String promptE = "分析一下" + drugName + "在治疗" + disease + "时的给药频次如何，单选" +
                "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                "并根据以下评分规则给予一个得分，单选：" +
                "返回参数scoreE（打分）和processE（原因）" +
                "2分：给药频次适宜，如≤1次·d^-1。" +
                "1.5分：给药频次适宜，如2次·d^-1。" +
                "1分：给药频次适宜，如≥3次·d^-1。";
        HashMap<String, String> stringStringHashMap1 = new HashMap<>();
        stringStringHashMap1.put("scoreE", "给药频次分数（只能是阿拉伯数字组成）");
        stringStringHashMap1.put("processE", "给药频次原因");

        JSONObject theorySupportResult1 = new JSONObject();
        if (!isNew){
            theorySupportResult1 = lxGptService.executeGptPlus(promptE, "给药频次", getResponseFormat(stringStringHashMap1), "","2,1.5,1");
        }else {
            theorySupportResult1 = gptAiUtils.executeGptPlus(promptE, "给药频次", getDemo("processE", "scoreE"), "","2,1.5,1");
        }


        String processE = theorySupportResult1.getString("processE");
        String scoreE = theorySupportResult1.getString("scoreE");
        usageAndDosage.put("processE", processE);
        usageAndDosage.put("scoreE", extractLastNumber(scoreE));


        write("drugFrequencyScore", formatScore(usageAndDosage.getString("scoreE")), response, stringBuilder,"给药频次");
        if (StringUtils.isNotEmpty(usag)){
            write("drugFrequency", usag, response, stringBuilder,"给药频次");
        }else {
            write("drugFrequency", processE, response, stringBuilder,"给药频次");
        }



        //使用方法

        String promptF = "你作为一名专业的西药的临床药师，非常熟悉药品使用的便捷性。 请根据我提供的药品相关使用信息，以及你自己的知识库，说明一下【" + drugName + "】的使用便捷性。" +
                "可以从以下几个方面评价" + drugName + "在使用过程中的便利性，包括但不限于：（1）药品的给药途径使用的便捷性\n" +
                "（2）是否有特殊要求：" +
                "1）是否需要专业操作（如注射笔 vs. 医院输液）；" +
                "2）是否需特殊设备（如雾化吸入器、胰岛素泵）；\n" +
                "（3）特殊人群适配性；" +
                "并根据以下评分规则给予一个得分：（单选）" +
                "2分：使用方便，无需辅助，可自行给药。" +
                "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                "1分：使用较为繁琐，需医务人员给药。" +
                "  请注意：" +
                "（1）如果患者能自行服药，直接给2分。如口服药品与外用药品等。不用考虑是否需要剂量调整，" +
                "（2）如果配备特殊设备或者需要专业操作的，可能需要医护人员指导后使用，给1.5分。" +
                "（3）如果是必须由医护人员给药的情况，给1分，如输液。" +
                "（4）请根据我提供的用法用量信息或你自身的知识库数据进行综合判断。上述注意事项并非绝对标准，若同时符合多项规则，最终评分应以最高分值为准。" +
                "（5） 返回的JSON字段包括：score为分数（只能是阿拉伯数字），process为" + drugName + "使用便捷性分析过程。" +
                "药品相关使用信息：’’’" +
                drugInfo.getUsageAndDosage() +
                "’’’";


        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("scoreF", "得分");
        stringStringHashMap.put("processF", "使用是否方便分析过程");

        JSONObject jsonObject1 = new JSONObject();
        if (!isNew){
            jsonObject1 = lxGptService.executeGptPlus(promptF, "usageAndDosage", getResponseFormat(stringStringHashMap), "","2,1.5,1");
        }else {
            jsonObject1 = gptAiUtils.executeGptPlus(promptF, "usageAndDosage", getDemo("processF", "scoreF"), "","2,1.5,1");
        }

        usageAndDosage.put("scoreF", extractLastNumber(jsonObject1.getString("scoreF")));
        usageAndDosage.put("processF", jsonObject1.getString("processF"));

        write("convenienceScore", formatScore(usageAndDosage.getString("scoreF")), response, stringBuilder,"使用方便");
        write("convenience", usageAndDosage.getString("processF"), response, stringBuilder,"使用方便");

        float usageAndDosageScore = 0f;
        try {
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreA")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreA")));
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreB")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreB")));
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreC")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreC")));
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreD")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreD")));
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreE")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreE")));
            pharmacyAnalysisScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreF")));
            usageAndDosageScore += Float.parseFloat(NumberUtils.extractNumbers(usageAndDosage.getString("scoreF")));
        } catch (Exception e) {
            pharmacyAnalysisScore += 0f;
        }


        //得分
        write("usageAndDosageScore", usageAndDosageScore, response, stringBuilder,"用法用量打分");
//        //详情
//        write("usageAndDosage", process_usageAndDosage_br,response,stringBuilder);

        // 4.贮藏条件
        long begin_storage = System.currentTimeMillis();
        JSONObject storage = new JSONObject();
        try {
            storage = lxGptService.storage(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (storage.getString("score") == null) {
                storage.put("score", 0);
                write("storageScore", 0, response, stringBuilder,"贮藏");
            } else {
                write("storageScore", storage.getString("score"), response, stringBuilder,"贮藏");
            }
            if (storage.getString("process") == null) {
                storage.put("process", "");
                write("storage", "", response, stringBuilder,"贮藏");
            } else {
                write("storage", storage.getString("process"), response, stringBuilder,"贮藏");
            }
        }
        log.info("storage  gpt  分析时长{}", System.currentTimeMillis() - begin_storage);


        // 5.药品有效期
        long begin_indate = System.currentTimeMillis();
        JSONObject indate = new JSONObject();
        try {
            indate = lxGptService.indate(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (indate.getString("score") == null) {
                indate.put("score", 0);
                write("indateScore", 0, response, stringBuilder,"有效期");
            } else {
                write("indateScore", indate.getString("score"), response, stringBuilder,"有效期");
            }
            if (indate.getString("process") == null) {
                indate.put("process", "");
                write("indate", "", response, stringBuilder,"有效期");
            } else {
                write("indate", indate.getString("process"), response, stringBuilder,"有效期");
            }
        }
        log.info("indate  gpt  分析时长{}", System.currentTimeMillis() - begin_indate);


        try {
            pharmacyAnalysisScore += Float.parseFloat(pharmacology.getString("score"));
        } catch (Exception e) {
            pharmacyAnalysisScore += 0f;
        }
        try {
            pharmacyAnalysisScore += Float.parseFloat(pharmacokinetics.getString("score"));
        } catch (Exception e) {
            pharmacyAnalysisScore += 0f;
        }


        try {
            pharmacyAnalysisScore += Float.parseFloat(storage.getString("score"));
        } catch (Exception e) {
            pharmacyAnalysisScore += 0f;
        }
        try {
            pharmacyAnalysisScore += Float.parseFloat(indate.getString("score"));
        } catch (Exception e) {
            pharmacyAnalysisScore += 0f;
        }


        // 计算药学特性部分总得分
        String pharmacyFormatScore = formatScore(new BigDecimal(pharmacyAnalysisScore).setScale(2, RoundingMode.HALF_UP).toString());
        pharmaceuticalCharacteristics.put("score", "药学特性得分：" + pharmacyFormatScore + "分");
        pharmaceuticalCharacteristics.put("characteristicScore", pharmacyFormatScore);
        write("characteristicScore", pharmacyFormatScore, response, stringBuilder,"要学特性得分");

        return step;
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

    private int effectiveAnalysis(String drugName, String disease,
                                  DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                  Map<Literature, JSONObject> literatureMap, List<CacheDto> stringBuilder, HttpServletResponse response) {
        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("effectiveness", "");
        effective.put("score", 0);
        effective.put("vscore", 0);
        effective.put("guide", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
        effective.put("guideAndLiteratureScore", 0);

//        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
//        addProcess(id, step++, "主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。", stringBuilder);

        // 2.1 适应症
//        long begin_indication = System.currentTimeMillis();
//        JSONObject indication = new JSONObject();
//        try {
//            indication = this.indication(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (indication.getString("score") == null) {
//                indication.put("score", 0);
//            }
//            if (indication.getString("process") == null) {
//                indication.put("process", "");
//            }
//        }
//        log.info("indication  gpt  分析时长{}", System.currentTimeMillis() - begin_indication);

        JSONObject indication = new JSONObject();

//        // 2.2 分析指南  如果有指南就不再分析文献   取分规则是取指南和文献的最高分
//        addProcess(id, step++, "（2）证据推荐详情：", stringBuilder);

        List<String> guideTitle = new ArrayList<>();
        int guideIndex = 0;
        // 2.2 指南
        // 等待异步执行完毕中间map有可能收到干扰
        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "guideResult")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                    break;
                }
            }
        } catch (ConcurrentModificationException e) {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "guideResult")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception ex) {
                        log.error(ex.getMessage(), ex);
                    }
                    break;
                }
            }

        }

        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "mainGuide")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                    break;
                }
            }
        } catch (ConcurrentModificationException e) {

            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "mainGuide")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception ex) {
                        log.error(ex.getMessage(), ex);
                    }
                    break;
                }
            }
        }


        if (Objects.nonNull(futureResult.get("indication"))) {
            try {
                Boolean isSuccess = futureResult.get("indication").get();
                if (isSuccess) {
                    indication = gptAnalysisMap.get("indication");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

//        addProcess(id, step++, "（1）适应证：", stringBuilder);
//        addProcess(id, step++, formatInfo(indication.getString("process")), stringBuilder);


        effective.put("indication", indication.getString("process"));
        effective.put("indicationScore", formatScore(indication.getString("score")));

        write("indicationScore", formatScore(indication.getString("score")), response, stringBuilder,"适应症");
        write("indication", indication.getString("process"), response, stringBuilder,"适应症");


        JSONArray jsonArray11 = new JSONArray();


        if (CollUtil.isNotEmpty(guideEffectiveMap)) {
            for (Map.Entry<GuideVO, JSONObject> guideVOJSONObjectEntry : guideEffectiveMap.entrySet()) {
                GuideVO guideVO = guideVOJSONObjectEntry.getKey();
                JSONObject guide = guideVOJSONObjectEntry.getValue();
                if (!StringUtils.isNumeric(guide.getString("score")) || StringUtils.isBlank(guide.getString("process"))) {
                    guideIndex++;
                    continue;
                }

                guideTitle.add("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate());
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("title", "《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate());
                jsonObject.put("content", guide.getString("process"));
                jsonArray11.add(jsonObject);
                if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
                    effective.put("guideAndLiteratureScore", formatScore(guide.getString("score")));
                }
                try {
                    if (Double.parseDouble(effective.getString("guideAndLiteratureScore")) < 4) {
                        effective.put("guideAndLiteratureScore", "4");
                    }
                } catch (Exception e) {
                    effective.put("guideAndLiteratureScore", "4");
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(guideVO.getTitle());
                jsonArray1.add(guideVO.getZdz());
                jsonArray1.add(guideVO.getFbdate());
                jsonArray1.add("-");
                jsonArray1.add(guide.getString("process"));
                effective.getJSONArray("guide").add(jsonArray1);
            }
        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap)) {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "reserveGuide")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }

            int size = guideOldEffectiveMap.size();
            do {
                List<GuideVO> guideVOS = new ArrayList<>(guideOldEffectiveMap.keySet());
                GuideVO searchHit = guideVOS.get(size - 1);
                JSONObject guideEffective = guideOldEffectiveMap.get(searchHit);
                if (!StringUtils.isNumeric(guideEffective.getString("score")) || StringUtils.isBlank(guideEffective.getString("process"))) {
                    continue;
                }

                guideTitle.add("《" + searchHit.getTitle() + "》 —— " + searchHit.getZdz() + " —— " + searchHit.getFbdate());

                JSONObject jsonObject = new JSONObject();
                jsonObject.put("title", "《" + searchHit.getTitle() + "》 —— " + searchHit.getZdz() + " —— " + searchHit.getFbdate());
                jsonObject.put("content", searchHit.getPdf_txt());

                jsonArray11.add(jsonObject);
                if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < guideEffective.getInteger("score")) {
                    effective.put("guideAndLiteratureScore", formatScore(guideEffective.getString("score")));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add("-");
                jsonArray1.add(guideEffective.getString("process"));
                effective.getJSONArray("guide").add(jsonArray1);
            } while (--guideIndex > 0 && --size > 0);
        }

        write("guideScore", effective.getString("guideAndLiteratureScore"), response, stringBuilder,"指南");
        write("guide", jsonArray11, response, stringBuilder,"指南");

//        if (CollUtil.isNotEmpty(guideTitle)) {
////            addProcess(id, step++, "&nbsp;&nbsp;&nbsp; 指南推荐：");
//            for (String title : guideTitle) {
//                addProcess(id, step++, title, stringBuilder);
//            }
//        }

        // 下面的指南部分 是没有使用线程池时的写法
//        for (GuideVO guideVO : guideVOList) {
//            long begin_guide = System.currentTimeMillis();
//            JSONObject guide = new JSONObject();
//            try {
//                String pdf_txt = guideVO.getPdf_txt();
//                String zdz = guideVO.getZdz();
//                String title = guideVO.getTitle();
//                guide = this.guide(drugName, disease, pdf_txt, zdz, title);
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (guide.getString("score") == null) {
//                    guide.put("score", 0);
//                }
//                if (guide.getString("process") == null) {
//                    guide.put("process", "");
//                }
//            }
//            log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);
//
//            if (!StringUtils.isNumeric(guide.getString("score")) || StringUtils.isBlank(guide.getString("process"))) {
//                guideIndex++;
//                continue;
//            }
//
//            guideTitle.add("《"+guideVO.getTitle()+"》");
////            addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//            if(effective.getInteger("guideAndLiteratureScore")==0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
//                effective.put("guideAndLiteratureScore", guide.getString("score"));
//            }
//
//            JSONArray jsonArray1 = new JSONArray();
//            jsonArray1.add(guideVO.getTitle());
//            jsonArray1.add(guideVO.getZdz());
//            jsonArray1.add(guideVO.getFbdate());
//            jsonArray1.add("-");
//            jsonArray1.add(guide.getString("process"));
//            effective.getJSONArray("guide").add(jsonArray1);
//        }
//
//        for (GuideVO guideVO : oldGuideVOList) {
//            if (guideIndex > 0) {
//                long begin_guide = System.currentTimeMillis();
//                JSONObject guide = new JSONObject();
//                try {
//                    String pdf_txt = guideVO.getPdf_txt();
//                    String zdz = guideVO.getZdz();
//                    String title = guideVO.getTitle();
//                    guide = this.guide(drugName, disease, pdf_txt, zdz, title);
//                } catch (Exception e) {
//                    log.error(e.getMessage(), e);
//                } finally {
//                    if (guide.getString("score") == null) {
//                        guide.put("score", 0);
//                    }
//                    if (guide.getString("process") == null) {
//                        guide.put("process", "");
//                    }
//                }
//                log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);
//
//                if (!StringUtils.isNumeric(guide.getString("score")) || StringUtils.isBlank(guide.getString("process"))) {
//                    continue;
//                }
//
////                addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//                guideTitle.add("《"+guideVO.getTitle()+"》");
//                if(effective.getInteger("guideAndLiteratureScore")==0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
//                    effective.put("guideAndLiteratureScore", guide.getString("score"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(guideVO.getTitle());
//                jsonArray1.add(guideVO.getZdz());
//                jsonArray1.add(guideVO.getFbdate());
//                jsonArray1.add("-");
//                jsonArray1.add(guide.getString("process"));
//                effective.getJSONArray("guide").add(jsonArray1);
//                guideIndex --;
//            }
//        }
//
//
//        if (CollUtil.isNotEmpty(guideTitle)) {
//            addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 指南推荐：");
//            for (String title : guideTitle) {
//                addProcess(id,step++,title);
//            }
//        }

        List<String> literatureTitle = new ArrayList<>(); // 存放被摘录的文献标题
        List<String> literatureTitleList = new ArrayList<>();  // 存放 gpt页面需要输出的文献
        // 如果没有指南进行分析 就再分析文献
        if (effective.getInteger("guideAndLiteratureScore") == 0) {
            // 等待异步执行完毕
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "literatureResult")) {
                    Future<Boolean> literatureResult = futureEntry.getValue();
                    try {
                        literatureResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StringUtils.startsWith(futureEntry.getKey(), "literature_")) {
                    Future<Boolean> literatureResult = futureEntry.getValue();
                    try {
                        literatureResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }

            effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));

            if (CollUtil.isNotEmpty(literatureMap)) {
                for (Map.Entry<Literature, JSONObject> literatureJSONObjectEntry : literatureMap.entrySet()) {
                    Literature literature = literatureJSONObjectEntry.getKey();
                    JSONObject literatureAnalysis = literatureJSONObjectEntry.getValue();
                    if (!StringUtils.isNumeric(literatureAnalysis.getString("score"))
                            || StringUtils.isBlank(literatureAnalysis.getString("process"))
                            || CollUtil.contains(literatureTitle, literature.getTitle())) {
                        continue;
                    }

                    // 因为文献的名字存在相同 但是 文献id不同的情况 去重
                    literatureTitle.add(literature.getTitle());
//                    addProcess(id, step++, "《" + literature.getTitle() + "》");
                    literatureTitleList.add("《" + literature.getTitle() + "》 —— " + literature.getJournal() + " —— " + literature.getYear());

                    if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < literatureAnalysis.getInteger("score")) {
                        effective.put("reason", literatureAnalysis.getString("reason"));
                        effective.put("guideAndLiteratureScore", formatScore(literatureAnalysis.getString("score")));
                    }

                    JSONArray jsonArray1 = new JSONArray();
                    jsonArray1.add(literature.getTitle());
                    jsonArray1.add(literature.getJournal());
                    jsonArray1.add(literature.getYear());
                    jsonArray1.add(literatureAnalysis.getString("process"));
                    effective.getJSONArray("literature").add(jsonArray1);
                }
            }

//            if (CollUtil.isNotEmpty(literatureTitleList)) {
////                addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 文献推荐：");
//                for (String title : literatureTitleList) {
//                    addProcess(id, step++, title, stringBuilder);
//                }
//            } else {
//                addProcess(id, step++, "暂未找到相关临床指南或系统评价/Meta分析等证据推荐。", stringBuilder);
//            }
        }


        JSONObject clinical = new JSONObject();
        if (Objects.nonNull(futureResult.get("clinical"))) {
            try {
                Boolean isSuccess = futureResult.get("clinical").get();
                if (isSuccess) {
                    clinical = gptAnalysisMap.get("clinical");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }


        effective.put("effectiveness", clinical.getString("process"));
        effective.put("effectivenessScore", formatScore(clinical.getString("score")));

        write("effectivenessScore", clinical.getString("score"), response, stringBuilder,"临床疗效");
        write("effectiveness", clinical.getString("process"), response, stringBuilder,"临床疗效");


        int effectiveVscore = 0;
        try {
            effectiveVscore = indication.getInteger("score") + clinical.getInteger("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        // 记录总得分
        effective.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其有效性进行评价：总分27分，主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。");
        String effectiveFormatSorce = formatScore(new BigDecimal(effectiveVscore + effective.getFloat("guideAndLiteratureScore")).setScale(2, RoundingMode.HALF_UP).toString());
        effective.put("vscore", effectiveFormatSorce);
        effective.put("score", "有效性得分：" + effectiveFormatSorce + "分");

        write("effectiveScore", effectiveFormatSorce, response, stringBuilder,"临床疗效");

        return step;
    }


    private int safetyAnalysis(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<CacheDto> stringBuilder, HttpServletResponse response) {
        //3 安全性部分
        JSONObject safety = new JSONObject();
        safety.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其安全性进行评价：总分25分，主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
        safety.put("details", new JSONObject());
        safety.put("specialPopulationsScore", "");
        safety.put("table", new JSONArray().fluentAdd(Arrays.asList("序号", "评价条目", "相关内容", "得分")));

//        addProcess(id, step++, "<b>3、安全性</b>", stringBuilder);
//        addProcess(id, step++, "主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。", stringBuilder);

        // 3.1 重度和中度不良反应
//        long begin_adverseReaction = System.currentTimeMillis();
//        JSONObject adverseReaction = new JSONObject();
//        try {
//            adverseReaction = this.adverseReaction(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (adverseReaction.getString("severeAdverseReaction") == null) {
//                adverseReaction.put("severeAdverseReaction", "");
//            }
//            if (adverseReaction.getString("mildAdverseReaction") == null) {
//                adverseReaction.put("mildAdverseReaction", "");
//            }
//            if (adverseReaction.getString("mildAdverseReactionScore") == null) {
//                adverseReaction.put("mildAdverseReactionScore", 0);
//            }
//            if (adverseReaction.getString("severeAdverseReactionScore") == null) {
//                adverseReaction.put("severeAdverseReactionScore", 0);
//            }
//        }
//        log.info("adverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_adverseReaction);

        JSONObject adverseReaction = new JSONObject();
        if (Objects.nonNull(futureResult.get("adverseReaction"))) {
            try {
                Boolean isSuccess = futureResult.get("adverseReaction").get();
                if (isSuccess) {
                    adverseReaction = gptAnalysisMap.get("adverseReaction");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

//        addProcess(id, step++, "（1）不良反应：", stringBuilder);
//        addProcess(id, step++, formatInfo("中度不良反应：" + adverseReaction.getString("mildAdverseReaction")), stringBuilder);
//        addProcess(id, step++, formatInfo("重度不良反应：" + adverseReaction.getString("severeAdverseReaction")), stringBuilder);
//        write("AdverseReactionScore", Double.parseDouble(formatScore(adverseReaction.getString("mildAdverseReactionScore"))) +
//                Double.parseDouble(formatScore(adverseReaction.getString("severeAdverseReactionScore"))), response, stringBuilder,"不良反应");
//        write("AdverseReaction", adverseReaction.getString("mildAdverseReaction") + "\n" + adverseReaction.getString("severeAdverseReaction"), response, stringBuilder,"不良反应");


        write("mildAdverseReactionScore", Double.parseDouble(formatScore(adverseReaction.getString("mildAdverseReactionScore")))
             , response, stringBuilder,"不良反应");

        write("mildAdverseReaction", adverseReaction.getString("mildAdverseReaction") , response, stringBuilder,"不良反应");


        write("severeAdverseReactionScore",
                Double.parseDouble(formatScore(adverseReaction.getString("severeAdverseReactionScore"))), response, stringBuilder,"重度不良反应");

        write("severeAdverseReaction",  adverseReaction.getString("severeAdverseReaction"), response, stringBuilder,"重度不良反应");

        write("AdverseReactionScore", Double.parseDouble(formatScore(adverseReaction.getString("mildAdverseReactionScore"))) +
                Double.parseDouble(formatScore(adverseReaction.getString("severeAdverseReactionScore"))), response, stringBuilder,"不良反应");

//        // 3.2 特殊人群-孕妇及哺乳期妇女
//        long begin_specialCrowd_pregnantWomen = System.currentTimeMillis();
//        JSONObject specialCrowd_pregnantWomen = new JSONObject();
//        try {
//            specialCrowd_pregnantWomen = this.specialCrowd_pregnantWomen(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_pregnantWomen.getString("pregnantScore") == null) {
//                specialCrowd_pregnantWomen.put("pregnantScore", 0);
//            }
//            if (specialCrowd_pregnantWomen.getString("lactatingScore") == null) {
//                specialCrowd_pregnantWomen.put("lactatingScore", 0);
//            }
//            if (specialCrowd_pregnantWomen.getString("process") == null) {
//                specialCrowd_pregnantWomen.put("process", "");
//            }
//        }
//        log.info("specialCrowd_pregnantWomen  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen);
//
        //儿童
        JSONObject specialCrowd_childrenMedicine = new JSONObject();
        if (Objects.nonNull(futureResult.get("specialCrowd_childrenMedicine"))) {
            try {
                Boolean isSuccess = futureResult.get("specialCrowd_childrenMedicine").get();
                if (isSuccess) {
                    specialCrowd_childrenMedicine = gptAnalysisMap.get("specialCrowd_childrenMedicine");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        if (Objects.nonNull(drugInfo) && StringUtils.isNotBlank(drugInfo.getChildrenMedicine())) {
            write("childrenMedicineScore", specialCrowd_childrenMedicine.getString("score"), response, stringBuilder,"儿童");
            write("childrenMedicine", drugInfo.getChildrenMedicine(), response, stringBuilder,"儿童");
        } else {
            write("childrenMedicineScore", specialCrowd_childrenMedicine.getString("score"), response, stringBuilder,"儿童");
            write("childrenMedicine", specialCrowd_childrenMedicine.getString("process"), response, stringBuilder,"儿童");
        }


        //老人
        JSONObject specialCrowd_geriatricMedicine = new JSONObject();
        if (Objects.nonNull(futureResult.get("specialCrowd_geriatricMedicine"))) {
            try {
                Boolean isSuccess = futureResult.get("specialCrowd_geriatricMedicine").get();
                if (isSuccess) {
                    specialCrowd_geriatricMedicine = gptAnalysisMap.get("specialCrowd_geriatricMedicine");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        if (Objects.nonNull(drugInfo) && StringUtils.isNotBlank(drugInfo.getGeriatricMedicine())) {
            write("geriatricMedicineScore", specialCrowd_geriatricMedicine.getString("score"), response, stringBuilder,"老人");
            write("geriatricMedicine", drugInfo.getGeriatricMedicine(), response, stringBuilder,"老人");
        } else {
            write("geriatricMedicineScore", specialCrowd_geriatricMedicine.getString("score"), response, stringBuilder,"老人");
            write("geriatricMedicine", specialCrowd_geriatricMedicine.getString("process"), response, stringBuilder,"老人");
        }


        JSONObject specialCrowd_pregnantWomen = new JSONObject();
        if (Objects.nonNull(futureResult.get("specialCrowd_pregnantWomen"))) {
            try {
                Boolean isSuccess = futureResult.get("specialCrowd_pregnantWomen").get();
                if (isSuccess) {
                    specialCrowd_pregnantWomen = gptAnalysisMap.get("specialCrowd_pregnantWomen");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }


        write("pregnantWomenScore", specialCrowd_pregnantWomen.getString("pregnantScore"), response, stringBuilder,"孕妇");
        write("pregnantWomen", specialCrowd_pregnantWomen.getString("pregnantProcess"), response, stringBuilder,"孕妇");
        write("lactationScore", specialCrowd_pregnantWomen.getString("lactatingScore"), response, stringBuilder,"哺乳期");
        write("lactation", specialCrowd_pregnantWomen.getString("lactatingProcess"), response, stringBuilder,"哺乳期");


//        // 3.2 特殊人群-儿童
//        long begin_specialCrowd_childrenMedicine = System.currentTimeMillis();
//        JSONObject specialCrowd_childrenMedicine= new JSONObject();
//        try {
//            specialCrowd_childrenMedicine = this.specialCrowd_childrenMedicine(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_childrenMedicine.getString("score") == null) {
//                specialCrowd_childrenMedicine.put("score", 0);
//            }
//            if (specialCrowd_childrenMedicine.getString("process") == null) {
//                specialCrowd_childrenMedicine.put("process", "");
//            }
//        }
//        log.info("specialCrowd_childrenMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_childrenMedicine);


//        // 3.3 特殊人群-老年
//        long begin_specialCrowd_geriatricMedicine = System.currentTimeMillis();
//        JSONObject specialCrowd_geriatricMedicine= new JSONObject();
//        try {
//            specialCrowd_geriatricMedicine = this.specialCrowd_geriatricMedicine(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_geriatricMedicine.getString("score") == null) {
//                specialCrowd_geriatricMedicine.put("score", 0);
//            }
//            if (specialCrowd_geriatricMedicine.getString("process") == null) {
//                specialCrowd_geriatricMedicine.put("process", "");
//            }
//        }
//        log.info("specialCrowd_geriatricMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_geriatricMedicine);


//        // 3.2 特殊人群-肝肾功能异常者
//        long begin_specialCrowd_liverKidney = System.currentTimeMillis();
//        JSONObject specialCrowd_liverKidney= new JSONObject();
//        try {
//            specialCrowd_liverKidney = this.specialCrowd_liverKidney(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_liverKidney.getString("score") == null) {
//                specialCrowd_liverKidney.put("score", 0);
//            }
//            if (specialCrowd_liverKidney.getString("process") == null) {
//                specialCrowd_liverKidney.put("process", "");
//            }
//        }
//        log.info("specialCrowd_liverKidney  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liverKidney);

        JSONObject specialCrowd_liverKidney = new JSONObject();
        if (Objects.nonNull(futureResult.get("specialCrowd_liverKidney"))) {
            try {
                Boolean isSuccess = futureResult.get("specialCrowd_liverKidney").get();
                if (isSuccess) {
                    specialCrowd_liverKidney = gptAnalysisMap.get("specialCrowd_liverKidney");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        write("liverScore", specialCrowd_liverKidney.getString("liverScore"), response, stringBuilder,"肝功能");
        write("liver", specialCrowd_liverKidney.getString("liverProcess"), response, stringBuilder,"肝功能");

        write("renalScore", specialCrowd_liverKidney.getString("kidneyScore"), response, stringBuilder,"肾功能");
        write("renal", specialCrowd_liverKidney.getString("kidneyProcess"), response, stringBuilder,"肾功能");

        float safetyVScore = 0f; // 计算安全分析总得分
        // 记录特殊人群总得分
        float specialCrowdScoreCalculate = 0f;
        //其他得分总等分
        float otherScore = 0f;

        float pregnantAndLactating = 0f;
        try {
            String string = specialCrowd_pregnantWomen.getString("pregnantScore");
            String string1 = specialCrowd_pregnantWomen.getString("lactatingScore");
            if (!canParseFloat(string)) {
                string = "0";
            }
            if (!canParseFloat(string1)) {
                string1 = "0";
            }
            pregnantAndLactating = Float.parseFloat(string) + Float.parseFloat(string1);
            safetyVScore += pregnantAndLactating;
            specialCrowdScoreCalculate += pregnantAndLactating;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("3", "孕妇及哺乳期妇女", (StringUtils.isNotBlank(drugInfo.getPregnantWomen()) ? StringUtils.replace(drugInfo.getPregnantWomen(), "<br>", "") : specialCrowd_pregnantWomen.getString("process")), formatNumber(pregnantAndLactating == 0f ? 0 : pregnantAndLactating)));

        float childrenMedicineScore = 0f;
        try {
//            childrenMedicineScore = Float.parseFloat(specialCrowd_childrenMedicine.getString("score"));
            childrenMedicineScore += Float.parseFloat(formatScore(new BigDecimal(specialCrowd_childrenMedicine.getString("score")).setScale(2, RoundingMode.HALF_UP).toString()));
            safetyVScore += childrenMedicineScore;
            specialCrowdScoreCalculate += childrenMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("4", "儿童", (StringUtils.isNotBlank(drugInfo.getChildrenMedicine()) ? StringUtils.replace(drugInfo.getChildrenMedicine(), "<br>", "") : specialCrowd_childrenMedicine.getString("process")), formatNumber(childrenMedicineScore == 0f ? 0 : childrenMedicineScore)));

        float geriatricMedicineScore = 0f;
        try {
            geriatricMedicineScore = Float.parseFloat(specialCrowd_geriatricMedicine.getString("score"));
            safetyVScore += geriatricMedicineScore;
            specialCrowdScoreCalculate += geriatricMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("5", "老人", (StringUtils.isNotBlank(drugInfo.getGeriatricMedicine()) ? StringUtils.replace(drugInfo.getGeriatricMedicine(), "<br>", "") : specialCrowd_geriatricMedicine.getString("process")), formatNumber(geriatricMedicineScore == 0f ? 0 : geriatricMedicineScore)));

        float liverAndKidney = 0f;
        try {
            liverAndKidney = Float.parseFloat(specialCrowd_liverKidney.getString("liverScore")) + Float.parseFloat(specialCrowd_liverKidney.getString("kidneyScore"));
            safetyVScore += liverAndKidney;
            specialCrowdScoreCalculate += liverAndKidney;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("6", "肝肾功能异常者", specialCrowd_liverKidney.getString("process"), formatNumber(liverAndKidney == 0f ? 0 : liverAndKidney)));

        //记录总得分
        write("specialCrowdScore", specialCrowdScoreCalculate, response, stringBuilder,"特殊人群总得分");


        String specialCrowdScoreTotal = formatScore(new BigDecimal(specialCrowdScoreCalculate).setScale(2, RoundingMode.HALF_UP).toString());
        safety.put("specialPopulationsScore", specialCrowdScoreTotal);

        JSONObject drugInteraction = new JSONObject();
        if (Objects.nonNull(futureResult.get("drugInteraction"))) {
            try {
                Boolean isSuccess = futureResult.get("drugInteraction").get();
                if (isSuccess) {
                    drugInteraction = gptAnalysisMap.get("drugInteraction");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }


//        if (Objects.nonNull(drugInfo) && StringUtils.isNotBlank(drugInfo.getDrugInteraction())) {
//            addProcess(id,step++,formatInfo(drugInfo.getDrugInteraction()));
//        } else {
//            addProcess(id,step++,formatInfo(drugInteraction.getString("process")));
//        }
        write("drugInteractionScore", drugInteraction.getString("score"), response, stringBuilder,"药物相互作用");
        write("drugInteraction", drugInteraction.getString("process"), response, stringBuilder,"药物相互作用");


        JSONObject otherAdverseReaction = new JSONObject();
        if (Objects.nonNull(futureResult.get("otherAdverseReaction"))) {
            try {
                Boolean isSuccess = futureResult.get("otherAdverseReaction").get();
                if (isSuccess) {
                    otherAdverseReaction = gptAnalysisMap.get("otherAdverseReaction");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        JSONObject genicityAdverseReaction = new JSONObject();
        if (Objects.nonNull(futureResult.get("genicityAdverseReaction"))) {
            try {
                Boolean isSuccess = futureResult.get("genicityAdverseReaction").get();
                if (isSuccess) {
                    genicityAdverseReaction = gptAnalysisMap.get("genicityAdverseReaction");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }


        write("reversibleReactionScore", otherAdverseReaction.getString("score"), response, stringBuilder,"不良反应可逆");
        write("reversibleReaction", otherAdverseReaction.getString("process"), response, stringBuilder,"不良反应可逆");
        write("genicityAdverseReactionScore", genicityAdverseReaction.getString("score"), response, stringBuilder,"致癌");
        write("genicityAdverseReaction", genicityAdverseReaction.getString("process"), response, stringBuilder,"致癌");
//        addProcess(id, step++, "3）用药警示：", stringBuilder);
        StringBuilder stringBuilder1 = new StringBuilder();
        float alertAdverseReactionScore = 1f;
        if (StringUtils.isNotEmpty(drugInfo.getBlackBoxWaringOfFDA())) {

            stringBuilder1.append("FDA黑框警告：\n");
            stringBuilder1.append(drugInfo.getBlackBoxWaringOfFDA() + "\n");
            alertAdverseReactionScore = 0f;
        }


        //五级中文
        String drugZh = drugInfo.getDrugZh();
        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugZh);
        drugZhs.addAll(drugInfo.getDrugSynonymZh());
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
        // Criteria criteria2 = Criteria.where("title").regex(Pattern.compile(".*" + drugZh + ".*", Pattern.CASE_INSENSITIVE));
        // 创建查询对象
        List<Criteria> orCriteriaList2 = new ArrayList<>();
        for (String drug : drugZhs) {
            orCriteriaList2.add(Criteria.where("title").regex(Pattern.compile(".*" + drug + ".*", Pattern.CASE_INSENSITIVE)));
        }
        Criteria criteria2 = new Criteria().orOperator(orCriteriaList2.toArray(new Criteria[0]));
        Query query2 = new Query(criteria2);
        query2.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
        List<JSONObject> pharmacovigilanceAdd = mongoTemplate.find(query2, JSONObject.class, "pharmacovigilance");
        if (pharmacovigilance.size() > 0 || pharmacovigilanceAdd.size() > 0) {
            stringBuilder1.append("药物警戒：\n");
            int x = 0;
            if (pharmacovigilance.size() > 0) {
                for (int i = 0; i < pharmacovigilance.size(); i++) {
                    String content = "";
                    JSONArray synopsis = pharmacovigilance.get(i).getJSONArray("synopsis");
                    for (String o : synopsis.toJavaList(String.class)) {
                        for (String s : drugZhs) {
                            if (o.contains(s)) {
                                content = o;
                            }
                        }
                    }
                    String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带圈数字的字符
                    x++;
                    stringBuilder1.append(circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                            "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")\n");
                    if (i == 0) {
//                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
//                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")..."), stringBuilder);
                    }
                    stringBuilder1.append("原文链接：" + pharmacovigilance.get(i).getString("title_url") + "\n");
                }
                alertAdverseReactionScore = 0f;
            } else {
                for (int i = 0; i < pharmacovigilanceAdd.size(); i++) {
                    String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带
                    x++;
                    stringBuilder1.append(circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
                            "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")\n");
                    stringBuilder1.append("原文链接：" + pharmacovigilanceAdd.get(i).getString("title_url") + "\n");
                    if (i == 0) {
//                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
//                                "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")..."), stringBuilder);
                    }

                }
                alertAdverseReactionScore = 0f;
            }

        }
        if (alertAdverseReactionScore == 1f) {
//            addProcess(id, step++, "暂未找到用药警示相关信息", stringBuilder);
            alertAdverseReactionScore = 1f;
            stringBuilder1.append("暂未找到用药警示相关信息");
        }
        write("alertAdverseReactionScore", alertAdverseReactionScore, response, stringBuilder,"用药警示");
        write("alertAdverseReaction", stringBuilder1.toString(), response, stringBuilder,"用药警示");


        float mildAdverseReactionScore = 0f;
        try {
            mildAdverseReactionScore = adverseReaction.getFloat("mildAdverseReactionScore");
            safetyVScore += mildAdverseReactionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        float severeAdverseReactionScore = 0f;
        try {
            severeAdverseReactionScore = adverseReaction.getFloat("severeAdverseReactionScore");
            safetyVScore += severeAdverseReactionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        safety.getJSONArray("table").add(Arrays.asList("1", "中度不良反应", adverseReaction.getString("mildAdverseReaction"), formatNumber(mildAdverseReactionScore)));
        safety.getJSONArray("table").add(Arrays.asList("2", "重度不良反应", adverseReaction.getString("severeAdverseReaction"), formatNumber(severeAdverseReactionScore)));


        float drugInteractionScore = 0f;
        try {
            drugInteractionScore = Float.parseFloat(formatScore(drugInteraction.getString("score")));
            safetyVScore += drugInteractionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
//        safety.getJSONArray("table").add(Arrays.asList("7","相互作用",StringUtils.isNotBlank(drugInfo.getDrugInteraction())?drugInfo.getDrugInteraction():drugInteraction.getString("process"), drugInteractionScore));
        safety.getJSONArray("table").add(Arrays.asList("7", "相互作用", drugInteraction.getString("process"), formatNumber(drugInteractionScore == 0f ? 0 : drugInteractionScore)));

        float otherAdverseReactionScore = 1f;
        try {
            otherAdverseReactionScore = Float.parseFloat(otherAdverseReaction.getString("score"));
            safetyVScore += otherAdverseReactionScore;
        } catch (Exception e) {
            otherAdverseReactionScore = Float.parseFloat("0");
            log.error(e.getMessage(), e);
        }
        float genicityAdverseReactionScore = 0f;
        try {
            genicityAdverseReactionScore = Float.parseFloat(formatScore(genicityAdverseReaction.getString("score")));
            safetyVScore += genicityAdverseReactionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            safetyVScore += alertAdverseReactionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            otherAdverseReactionScore = otherAdverseReactionScore == 0f ? 0 : otherAdverseReactionScore;
            genicityAdverseReactionScore = genicityAdverseReactionScore == 0f ? 0 : genicityAdverseReactionScore;
            otherScore = otherAdverseReactionScore + genicityAdverseReactionScore + alertAdverseReactionScore;

        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }


        safety.getJSONArray("table").add(Arrays.asList("8", "不良反应可逆性", otherAdverseReaction.getString("process"), formatNumber(otherAdverseReactionScore == 0f ? 0 : otherAdverseReactionScore)));
        safety.getJSONArray("table").add(Arrays.asList("9", "致畸性、致癌性", genicityAdverseReaction.getString("process"), formatNumber(genicityAdverseReactionScore == 0f ? 0 : genicityAdverseReactionScore)));
        safety.getJSONArray("table").add(Arrays.asList("10", "用药警示", stringBuilder1.toString(), formatNumber(alertAdverseReactionScore)));
        String safetyOtherScore = formatNumber(otherScore);
        String safetyFormatScore = formatScore(new BigDecimal(safetyVScore).setScale(2, RoundingMode.HALF_UP).toString());
        safety.put("specialPopulationsScore", specialCrowdScoreTotal);
        safety.put("safetyOtherScore", safetyOtherScore);
        safety.put("score", "安全性得分：" + safetyFormatScore + "分");
        safety.put("vscore", safetyFormatScore);
        result.put("safety", safety);
        result.put("time", DateUtil.formatDateTime(new Date()));

        write("otherSafetyScore", safetyOtherScore, response, stringBuilder,"其他得分");
        write("safetyScore", safetyFormatScore, response, stringBuilder,"安全性得分");
        return step;
    }
    private int economicalAnalysisApp(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String priceId, String enterpriseName, List<CacheDto> stringBuilder, HttpServletResponse response) {
        JSONObject economical = new JSONObject();
        result.put("economical", economical);
        try {
            // 当前药品价格信息
            SaveDrugPrice currDrugFee = this.mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId).and("drugName").is(drugName).and("manufacturer").is(enterpriseName)), SaveDrugPrice.class);
            BigDecimal economicalVScore = new BigDecimal(0);
            economical.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其经济性进行评价：总分10分，考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。");
            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getMinAverageDailyCost() != null) {
                try {
                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, RoundingMode.HALF_UP);
                    if (score.floatValue() > 3) {
                        score = BigDecimal.valueOf(3);
                    }
                    economicalVScore = economicalVScore.add(score);
                    economical.put("sameGericName", "评价方法：日均治疗费用最低的药品为" + formatScore(score.toString()) + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x3。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                economicalVScore = economicalVScore.add(new BigDecimal(3));
                economical.put("sameGericName", "待评价药品无同通用名药品，得3分。");
            }

            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getAlternativeMinAverageDailyCost() != null) {
                try {
                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getAlternativeMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, RoundingMode.HALF_UP);
                    if (score.floatValue() > 7) {
                        score = BigDecimal.valueOf(7);
                    }
                    economicalVScore = economicalVScore.add(score);
                    economical.put("indicationReplace", "评价方法：日均治疗费用最低的药品为" + formatScore(score.toString()) + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x7。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                economicalVScore = economicalVScore.add(new BigDecimal(0));
                economical.put("indicationReplace", "待评价药品无主要适应证可替代药品，得0分。");
            }
            economicalVScore = economicalVScore.setScale(2, RoundingMode.HALF_UP);

            String economicalFormatScore = formatScore(economicalVScore.toString());
            economical.put("score", "经济性得分：" + economicalFormatScore + "分");
            economical.put("vscore", economicalFormatScore);
//            addProcess(id, step++, "<b>4、经济性</b>", stringBuilder);
//            addProcess(id, step++, "考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。根据您输入的内容，系统为您计算该药品在经济性上的评分结果为" + economicalFormatScore + "分。", stringBuilder);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return step;
    }
    public PriceVo economicalAnalysis(SaveDrugPrice2 saveDrugPrice) {

        PriceVo priceVo = new PriceVo("0", "0", "0");

        BigDecimal economicalVScore = new BigDecimal(0);

        Double averageDailyCost = 0.0;
        Double replaceableCost = 0.0;
        Double alternativeMinAverageDailyCost = 0.0;

        if (ObjectUtil.isNotEmpty(saveDrugPrice)) {
            Double price = saveDrugPrice.getPrice();
            String singleQuantityStr = saveDrugPrice.getSingleQuantity();
            String substring = singleQuantityStr.substring(0, singleQuantityStr.length() - 1);
            Double singleQuantity = Double.parseDouble(substring);
            Double frequencyStr = getThirdCharacterAsArabic(saveDrugPrice.getFrequency());
            // 尝试将字符串转换为 Double 类型
            averageDailyCost = price * frequencyStr * singleQuantity;


            try {
                if (
                        ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativeFrequency())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativePrice())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativeSingleQuantity())) {
                    String alternativeSingleQuantityStr = saveDrugPrice.getAlternativeSingleQuantity();
                    String alternativeSubstring = alternativeSingleQuantityStr.substring(0, alternativeSingleQuantityStr.length() - 1);
                    Double alternativeSingleQuantity = Double.parseDouble(alternativeSubstring);
                    Double alternativeFrequencyStr = getThirdCharacterAsArabic(saveDrugPrice.getAlternativeFrequency());
                    String alternativePriceStr = saveDrugPrice.getAlternativePrice();
                    // 尝试将字符串转换为 Double 类型
                    Double alternativePrice = Double.parseDouble(alternativePriceStr);
                    alternativeMinAverageDailyCost = alternativePrice * alternativeFrequencyStr * alternativeSingleQuantity;
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                if (
                        ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceablePrice())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceableFrequency())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceableSingleQuantity())) {
                    String replaceableSingleQuantityStr = saveDrugPrice.getReplaceableSingleQuantity();
                    String replaceableSubstring = replaceableSingleQuantityStr.substring(0, replaceableSingleQuantityStr.length() - 1);
                    Double replaceableSingleQuantity = Double.parseDouble(replaceableSubstring);
                    Double replaceablePrice = Double.parseDouble(saveDrugPrice.getReplaceablePrice());
                    Double replaceableFrequency = getThirdCharacterAsArabic(saveDrugPrice.getReplaceableFrequency());
                    replaceableCost = replaceablePrice * replaceableFrequency * replaceableSingleQuantity;
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

        }
        if (averageDailyCost != 0 && alternativeMinAverageDailyCost != 0) {
            try {
                BigDecimal score = BigDecimal.valueOf(alternativeMinAverageDailyCost).divide(BigDecimal.valueOf(averageDailyCost), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, RoundingMode.HALF_UP);
                if (score.floatValue() > 3) {
                    score = BigDecimal.valueOf(3);
                }
                priceVo.setPriceScore1(formatScore(score.toString()));
                economicalVScore = economicalVScore.add(score);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        } else {
            economicalVScore = economicalVScore.add(new BigDecimal(3));
            priceVo.setPriceScore1(formatScore("3"));
        }

        if (averageDailyCost != 0 && replaceableCost != 0) {
            try {
                BigDecimal score = BigDecimal.valueOf(replaceableCost).divide(BigDecimal.valueOf(averageDailyCost), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, RoundingMode.HALF_UP);
                if (score.floatValue() > 7) {
                    score = BigDecimal.valueOf(7);

                }
                priceVo.setPriceScore2(formatScore(score.toString()));
                economicalVScore = economicalVScore.add(score);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        } else {
            economicalVScore = economicalVScore.add(new BigDecimal(0));
            priceVo.setPriceScore2(formatScore("0"));

        }
        economicalVScore = economicalVScore.setScale(2, RoundingMode.HALF_UP);

        String economicalFormatScore = formatScore(economicalVScore.toString());
        priceVo.setPriceScore(economicalFormatScore);
        return priceVo;
    }
    
    public EconomicalVo economicalAnalysisPlus(SaveDrugPrice2 saveDrugPrice) {


        EconomicalVo economicalVo = new EconomicalVo();
        BigDecimal economicalVScore = new BigDecimal(0);
        Double averageDailyCost = 0.0;
        Double replaceableCost = 0.0;
        Double alternativeMinAverageDailyCost = 0.0;
        if (ObjectUtil.isNotEmpty(saveDrugPrice)) {
            Double price = saveDrugPrice.getPrice();
            String singleQuantityStr = saveDrugPrice.getSingleQuantity();
            String substring = singleQuantityStr.substring(0, singleQuantityStr.length() - 1);
            Double singleQuantity = Double.parseDouble(substring);
            Double frequencyStr = getThirdCharacterAsArabic(saveDrugPrice.getFrequency());
            // 尝试将字符串转换为 Double 类型
            averageDailyCost = price * frequencyStr * singleQuantity;


            try {
                if (
                        ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativeFrequency())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativePrice())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getAlternativeSingleQuantity())) {
                    String alternativeSingleQuantityStr = saveDrugPrice.getAlternativeSingleQuantity();
                    String alternativeSubstring = alternativeSingleQuantityStr.substring(0, alternativeSingleQuantityStr.length() - 1);
                    Double alternativeSingleQuantity = Double.parseDouble(alternativeSubstring);
                    Double alternativeFrequencyStr = getThirdCharacterAsArabic(saveDrugPrice.getAlternativeFrequency());
                    String alternativePriceStr = saveDrugPrice.getAlternativePrice();
                    // 尝试将字符串转换为 Double 类型
                    Double alternativePrice = Double.parseDouble(alternativePriceStr);
                    alternativeMinAverageDailyCost = alternativePrice * alternativeFrequencyStr * alternativeSingleQuantity;
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                if (
                        ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceablePrice())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceableFrequency())
                                && ObjectUtil.isNotEmpty(saveDrugPrice.getReplaceableSingleQuantity())) {
                    String replaceableSingleQuantityStr = saveDrugPrice.getReplaceableSingleQuantity();
                    String replaceableSubstring = replaceableSingleQuantityStr.substring(0, replaceableSingleQuantityStr.length() - 1);
                    Double replaceableSingleQuantity = Double.parseDouble(replaceableSubstring);
                    Double replaceablePrice = Double.parseDouble(saveDrugPrice.getReplaceablePrice());
                    Double replaceableFrequency = getThirdCharacterAsArabic(saveDrugPrice.getReplaceableFrequency());
                    replaceableCost = replaceablePrice * replaceableFrequency * replaceableSingleQuantity;
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

        }
        if (averageDailyCost != 0 && alternativeMinAverageDailyCost != 0) {
            try {
                BigDecimal score = BigDecimal.valueOf(alternativeMinAverageDailyCost).divide(BigDecimal.valueOf(averageDailyCost), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, RoundingMode.HALF_UP);
                if (score.floatValue() > 3) {
                    score = BigDecimal.valueOf(3);
                }
                economicalVScore = economicalVScore.add(score);
                economicalVo.setEconomicScore1(formatScore(score.toString()));
                economicalVo.setEconomical1("评价方法：日均治疗费用最低的药品为" + formatScore(score.toString()) + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x3。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        } else {
            economicalVScore = economicalVScore.add(new BigDecimal(3));
            economicalVo.setEconomicScore1(formatScore("3"));
            economicalVo.setEconomical1("待评价药品无同通用名药品，得3分。");
        }

        if (averageDailyCost != 0 && replaceableCost != 0) {
            try {
                BigDecimal score = BigDecimal.valueOf(replaceableCost).divide(BigDecimal.valueOf(averageDailyCost), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, RoundingMode.HALF_UP);
                if (score.floatValue() > 7) {
                    score = BigDecimal.valueOf(7);
                }
                economicalVScore = economicalVScore.add(score);
                economicalVo.setEconomicScore2(formatScore(score.toString()));
                economicalVo.setEconomical2("评价方法：日均治疗费用最低的药品为" + formatScore(score.toString()) + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x7。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        } else {
            economicalVScore = economicalVScore.add(new BigDecimal(0));
            economicalVo.setEconomical2("待评价药品无主要适应证可替代药品，得0分。");
            economicalVo.setEconomicScore2("0");
        }
        economicalVScore = economicalVScore.setScale(2, RoundingMode.HALF_UP);
        economicalVo.setEconomicalScore(formatScore(economicalVScore.toString()));

        return economicalVo;
    }

    public Double getThirdCharacterAsArabic(String input) {
        // 检查字符串长度
        return DIGIT_MAP.get(input);
    }

    private int otherAnalysis(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String enterpriseName, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<CacheDto> stringBuilder, HttpServletResponse response) {
        // 5.其他属性部分
//        addProcess(id, step++, "<b>5、其他属性</b>", stringBuilder);
//        addProcess(id, step++, "考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。", stringBuilder);

        float otherVscore = 0f;
        // 5.1 国家医保纳入情况模块
        //是否在医保目录
        //boolean isInsurance = this.mongoTemplate.exists(new Query(Criteria.where("registered_name").is(drugName).and("medicine_enterprise").is(enterpirceName)),JSONObject.class,"medical_insurance_drugs");
        boolean isInsurance = false;
        String medicalInsurance = drugInfo1.getMedicalInsurance();
        if (StringUtils.isNotBlank(medicalInsurance)) {
            isInsurance = true;
        }
//        addProcess(id, step++, "（1）国家医保纳入情况：", stringBuilder);
//        addProcess(id, step++, isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? "，" + drugInfo1.getMedicalInsurance() : "") : "未纳入医保", stringBuilder);


        // 医保得分
        float isInsuranceScore = 1.00F;
        boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo1.getPaymentScope());
        if (isInsurance) {

            if ("甲".equals(medicalInsurance)) {
                if (paymentScopeStatus) {
                    isInsuranceScore = 2.50F;
                } else {
                    isInsuranceScore = 3.00F;
                }
            } else {
                if (paymentScopeStatus) {
                    isInsuranceScore = 1.50F;
                } else {
                    isInsuranceScore = 2.00F;
                }
            }
        }
        write("isInsuranceScore", isInsuranceScore, response, stringBuilder,"医保");
        write("isInsurance", isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? "，" + drugInfo1.getMedicalInsurance() : "") + "，"
                + (paymentScopeStatus ? drugInfo1.getPaymentScope() : "无支付限制") : "未纳入医保", response, stringBuilder,"医保");
        otherVscore = isInsuranceScore;

        // 5.2 国家基本药物目录纳入情况模块
        //是否基本药物
        //boolean isBase = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("essentialMedicines").is("是")),DrugAndPrice.class);
        boolean isBase = false;
        String essentialMedicines = drugInfo1.getEssentialMedicines();
        if ("是".equals(essentialMedicines)) {
            isBase = true;
        }
//        addProcess(id, step++, "（2）国家基本药物目录纳入情况：", stringBuilder);
//        addProcess(id, step++, isBase ? "已被纳入国家基本药物目录" : "未纳入国家基本药物目录", stringBuilder);
        int typeScore = 0;
        String essentialType = drugInfo1.getEssentialType();
        if (StringUtils.isNotBlank(essentialType)) {
            typeScore = 1;
        }
        write("isBaseScore", isBase ? (3 - typeScore) : 1, response, stringBuilder,"基药");
        write("isBase", isBase ? "已被纳入国家基本药物目录，" + (StringUtils.isNotBlank(essentialType) ? "有△要求" : "无△要求") : "未纳入国家基本药物目录", response, stringBuilder,"基药");
        otherVscore = isBase ? otherVscore + 3 - typeScore : otherVscore + 1;

        // 5.3 国家集中采购情况模块
        //是否集中采购
        //boolean isConcentrate = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("enterprise").is(enterpirceName)),JSONObject.class,"country_concentrate_drugs");
        boolean isConcentrate = true;
        String drugCollection = drugInfo1.getDrugCollection();
        if ("本品非集采药品。".equals(drugCollection) || drugCollection.contains("不属于")) {
            isConcentrate = false;
        }
//        addProcess(id, step++, "（3）国家集中采购情况：", stringBuilder);
//        addProcess(id, step++, isConcentrate ? "已纳入国家集中采购" : "未纳入国家集中采购", stringBuilder);
        write("isConcentrateScore", isConcentrate ? 1 : 0, response, stringBuilder,"集采");
        write("isConcentrate", isConcentrate ? "已纳入国家集中采购" : "未纳入国家集中采购", response, stringBuilder,"集采");
        otherVscore = isConcentrate ? otherVscore + 1 : otherVscore;

        // 5.4  药品情况模块
        String drugSituationString = "未知";
//        long begin_guideDrugSituation = System.currentTimeMillis();
//        JSONObject guideDrugSituation = new JSONObject();
//        try {
//            guideDrugSituation = this.guideDrugSituation(drugName, enterpriseName);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (guideDrugSituation.getString("score") == null) {
//                guideDrugSituation.put("score", 0);
//            }
//            if (guideDrugSituation.getString("process") == null) {
//                guideDrugSituation.put("process", "");
//            }
//        }
//        log.info("guideDrugSituation  gpt  分析时长{}", System.currentTimeMillis() - begin_guideDrugSituation);

        JSONObject guideDrugSituation = new JSONObject();
        if (Objects.nonNull(futureResult.get("guideDrugSituation"))) {
            try {
                Boolean isSuccess = futureResult.get("guideDrugSituation").get();
                if (isSuccess) {
                    guideDrugSituation = gptAnalysisMap.get("guideDrugSituation");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

//        addProcess(id, step++, "（4）药品情况：", stringBuilder);
        String process = "";
        try {
            process = guideDrugSituation.getString("process");
            otherVscore += guideDrugSituation.getFloat("score");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        if (StringUtils.isNotBlank(process)) {
//            addProcess(id, step++, formatInfo(process), stringBuilder);
            write("guideDrugSituationScore", guideDrugSituation.getFloat("score"), response, stringBuilder,"原研/参比/一致性评价");
            write("guideDrugSituation", process, response, stringBuilder,"原研/参比/一致性评价");
            drugSituationString = process;
        } else {
            write("guideDrugSituationScore", 0, response, stringBuilder,"生产企业状况");
            write("guideDrugSituation", "未知", response, stringBuilder,"生产企业状况");
//            addProcess(id, step++, "未知", stringBuilder);
        }


        // 5.5 生产企业情况模块
        String enterpriseString = "未知";
        //生产企业情况
//        long begin_guideEnterprise = System.currentTimeMillis();
//        JSONObject guideEnterprise = new JSONObject();
//        try {
//            guideEnterprise = this.guideEnterprise(enterpriseName);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (guideEnterprise.getString("score") == null) {
//                guideEnterprise.put("score", 0);
//            }
//            if (guideEnterprise.getString("process") == null) {
//                guideEnterprise.put("process", "");
//            }
//        }
//        log.info("guideEnterprise  gpt  分析时长{}", System.currentTimeMillis() - begin_guideEnterprise);
        JSONObject guideEnterprise = new JSONObject();
        if (Objects.nonNull(futureResult.get("guideEnterprise"))) {
            try {
                Boolean isSuccess = futureResult.get("guideEnterprise").get();
                if (isSuccess) {
                    guideEnterprise = gptAnalysisMap.get("guideEnterprise");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

//        addProcess(id, step++, "（5）生产企业状况：", stringBuilder);
        String process_enterprise = "";
        try {
            process_enterprise = StringUtils.isNotBlank(drugInfo1.getManufacturers()) ? drugInfo1.getManufacturers() : guideEnterprise.getString("process");
            otherVscore += guideEnterprise.getFloat("score");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        if (StringUtils.isNotBlank(process)) {
//            addProcess(id, step++, formatInfo(process_enterprise), stringBuilder);
            write("guideEnterpriseScore", formatScore(guideEnterprise.getString("score")), response, stringBuilder,"指南");
            write("guideEnterprise", process_enterprise, response, stringBuilder,"指南");
            enterpriseString = process_enterprise;
        } else {
//            addProcess(id, step++, "未知", stringBuilder);
            write("guideEnterpriseScore", 0, response, stringBuilder,"指南");
            write("guideEnterprise", "未知", response, stringBuilder,"指南");
        }


        // 5.6 全球使用情况模块
        //全球使用情况
        String countryString = "未知";
//        long begin_guideCountry = System.currentTimeMillis();
//        JSONObject guideCountry = new JSONObject();
//        try {
//            guideCountry = this.guideCountry(drugName);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (guideCountry.getString("score") == null) {
//                guideCountry.put("score", 0);
//            }
//            if (guideCountry.getString("process") == null) {
//                guideCountry.put("process", "");
//            }
//            String process_country = guideCountry.getString("process");
//            process_country = process_country.replaceFirst("\\{", "");
//            process_country = process_country.replaceFirst("\\}", "");
//            guideCountry.put("process", process_country);
//
//        }
//        log.info("guideCountry  gpt  分析时长{}", System.currentTimeMillis() - begin_guideCountry);

        JSONObject guideCountry = new JSONObject();
        if (Objects.nonNull(futureResult.get("guideCountry"))) {
            try {
                Boolean isSuccess = futureResult.get("guideCountry").get();
                if (isSuccess) {
                    guideCountry = gptAnalysisMap.get("guideCountry");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

//        addProcess(id, step++, "（6）全球使用情况：", stringBuilder);
        String process1="暂无相关信息";
        String process2="暂无相关信息";
        String score1 = "0";
        String score2 = "0";
        String process_country = "";
        try {


            {
                String prompt = "请根据如下内容" + drugInfo1.getGlobalUsage() + "请根据药品注册信息、药品评审信息、国家药品监督管理局等官方网站或相关资讯，及自身知识库" +
                        "，分析" + drugName + "的上市情况，" +
                        "并根据分析结果内容进行打分，打分规则如下：\n" +
                        "中国、美国、欧洲、日本均已上市  1分\n" +
                        "未上市  0分\n" +
                        "返回内容为：1.打分（只要阿拉伯数字如：1或者0）" +
                        "2.相关上市的信息" + "";

                HashMap<String, String> stringStringHashMap = new HashMap<>();
                stringStringHashMap.put("score", "打分信息（阿拉伯数字即可）");
                stringStringHashMap.put("process", "上市相关信息");
                JSONObject responseFormat = getResponseFormat(stringStringHashMap);
                JSONObject jsonObject = gptAiUtils.executeGptPlus(prompt, "guideCountry", getDemo("process","score"),"","1,0.5,0");
                 process1 = jsonObject.getString("process");
                 score1 = jsonObject.getString("score");
            }
            {
                String prompt = "请根据如下内容" + drugInfo1.getGlobalUsage() + "请根据药品注册信息、药品评审信息、国家药品监督管理局等官方网站或相关资讯，及自身知识库" +
                        "，分析" + drugName + "的销售情况，" +
                        "并根据分析结果内容进行打分，打分规则如下：\n" +
                        "国内外均有销售  0.5分\n" +
                        "其他  0分\n" +
                        "返回内容为：1.打分（只要阿拉伯数字如：0.5或者0）" +
                        "2.销售情况的信息" + "";

                HashMap<String, String> stringStringHashMap = new HashMap<>();
                stringStringHashMap.put("score","打分信息（阿拉伯数字即可）");
                stringStringHashMap.put("process","销售情况相关信息");
                JSONObject responseFormat = getResponseFormat(stringStringHashMap);
               // JSONObject jsonObject = lxGptService.executeGptPlus(prompt, "上市相关", responseFormat, "","0.5,0");
                JSONObject jsonObject = gptAiUtils.executeGptPlus(prompt, "上市相关", getDemo("process","score"), "","0.5,0");
                 process2 = jsonObject.getString("process");
                 score2 = jsonObject.getString("score");
            }
//            otherVscore += Float.parseFloat(formatScore(guideCountry.getString("score")));
//            process_country = StringUtils.isNotBlank(drugInfo1.getGlobalUsage()) ? drugInfo1.getGlobalUsage() : guideCountry.getString("process");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        String countryScore = "";
        if (Double.parseDouble(formatScore(score1))>Double.parseDouble(formatScore(score2))){
            countryScore = formatScore(score1);
            otherVscore += Float.parseFloat(formatScore(score1));
        }else {
            countryScore = formatScore(score2);
            otherVscore += Float.parseFloat(formatScore(score2));
        }

        write("guideCountryScore", countryScore, response, stringBuilder,"使用情况");
        write("guideCountryScore1", formatScore(score1), response, stringBuilder,"上市情况");
        write("guideCountry1",process1, response, stringBuilder,"上市情况");
        write("guideCountryScore2", formatScore(score2), response, stringBuilder,"销售情况");
        write("guideCountry2",process2, response, stringBuilder,"销售情况");


//        if (StringUtils.isNotBlank(process_country)) {
////            addProcess(id, step++, formatInfo(process_country), stringBuilder);
//            write("guideCountryScore1", formatScore(guideCountry.getString("score")), response, stringBuilder,"全球使用情况");
//            write("guideCountry1", process_country, response, stringBuilder,"全球使用情况");
//            countryString = process_country;
//        } else {
////            addProcess(id, step++, "未知", stringBuilder);
//            write("guideCountryScore", 0, response, stringBuilder,"全球使用情况");
//            write("guideCountry", "未知", response, stringBuilder,"全球使用情况");
//        }

        // 第六部分 药品综合评价之其他属性
        JSONObject otherAttributes = new JSONObject();
        result.put("otherAttributes", otherAttributes);
        String otherFormatScore = formatScore(new BigDecimal(otherVscore).setScale(2, RoundingMode.HALF_UP).toString());
        otherAttributes.put("score", "其他属性得分：" + formatScore(otherFormatScore) + "分");
        write("otherScore", formatScore(otherFormatScore), response, stringBuilder,"其他属性得分");
        otherAttributes.put("vscore", formatScore(otherFormatScore));
        /*DrugAndPrice drugAndPrice;
        if(drugNameWords != null && CollectionUtil.isNotEmpty(drugNameWords.getJSONArray("words"))){
            drugAndPrice = this.mongoTemplate.findOne(new Query(Criteria.where("productName").in(drugNameWords.getJSONArray("words"))),DrugAndPrice.class);
        }else {
            drugAndPrice = this.mongoTemplate.findOne(new Query(Criteria.where("productName").is(drugName)),DrugAndPrice.class);
        }*/
        otherAttributes.put("paymentLimits", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
        otherAttributes.put("essentialMedicines", isBase);
        otherAttributes.put("reimbursementList", isInsurance);
        otherAttributes.put("reimbursement", StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? drugInfo1.getMedicalInsurance() + "类" : "");
        //支付限制
        otherAttributes.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
        otherAttributes.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其他属性进行评价：总分10分，考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。");
        //是否列为国家集中采购药品
        otherAttributes.put("procurementOfDrugs", isConcentrate);
        //国家基本药物得分
        otherAttributes.put("essentialMedicinesScore", isBase ? 3 - typeScore : 1);
        //有无△要求
        otherAttributes.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
        //国家医保目录得分
        otherAttributes.put("reimbursementListScore", formatScore(String.valueOf(isInsuranceScore)));
        //国家集中采购药品得分
        otherAttributes.put("procurementOfDrugsScore", isConcentrate ? 1 : 0);
        //原研/参比/一致性评价
        otherAttributes.put("guideDrugSituation", drugSituationString);
        try {
            otherAttributes.put("guideDrugSituationScore", formatScore(String.valueOf(guideDrugSituation.getFloat("score"))));
        } catch (Exception e) {
            otherAttributes.put("guideDrugSituationScore", 0);
            log.error(e.getMessage(), e);
        }
        //生产企业状态
        otherAttributes.put("guideEnterprise", enterpriseString);
        try {
            otherAttributes.put("guideEnterpriseScore", StringUtils.isNotEmpty(process_enterprise) ? formatScore(String.valueOf(guideEnterprise.getFloat("score"))) : 0);
        } catch (Exception e) {
            otherAttributes.put("guideEnterpriseScore", 0);
            log.error(e.getMessage(), e);
        }
        //全球使用情况
        otherAttributes.put("guideCountry", countryString);
        try {




            otherAttributes.put("guideCountryScore", guideCountry != null ? formatScore(String.valueOf(guideCountry.getFloat("score"))) : 0);
        } catch (Exception e) {
            otherAttributes.put("guideCountryScore", 0);
            log.error(e.getMessage(), e);
        }
        otherAttributes.put("table", new JSONArray());
        otherAttributes.getJSONArray("table").add(Arrays.asList("药品名称", "原研/参比/一致性评价", "生产厂家", "生产企业状态", "全球使用情况"));
        otherAttributes.getJSONArray("table").add(Arrays.asList(drugName, drugSituationString, enterpriseName, enterpriseString, countryString));
        result.put("otherAttributes", otherAttributes);

        try {
            JSONObject overallSummary = new JSONObject();
            overallSummary.put("targetDrug", drugName);
            BigDecimal vscore = new BigDecimal("0");
            try {
                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("safety").getFloat("vscore")));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("pharmaceuticalCharacteristics").getFloat("vscore")));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("effectiveness").getFloat("vscore")));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("otherAttributes").getFloat("vscore")));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            try {
                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("economical").getFloat("vscore")));
            } catch (Exception e) {
//                log.error(e.getMessage(), e);
            }
            result.put("overallSummary", overallSummary);
            overallSummary.put("comprehensiveScore", formatScore(String.valueOf(vscore.setScale(2, RoundingMode.HALF_UP))));

            overallSummary.put("dimensionDiagram", new JSONArray());
            overallSummary.put("score", vscore.setScale(2, RoundingMode.HALF_UP));

            BigDecimal bigDecimal = vscore.setScale(2, RoundingMode.HALF_UP);
            float value = bigDecimal.floatValue();
            String status;
            if (value > 70) {
                status = "强推荐";
                overallSummary.put("recommendation", "临床上治疗" + disease + "：用于新品引进时，建议为" + status + "；用于药品调出时，建议为保留。");
            } else if (value < 60) {
                status = "不推荐";
                overallSummary.put("recommendation", "临床上治疗" + disease + "：用于新品引进时，建议为" + status + "；用于药品调出时，建议为调出。");
            } else {
                status = "弱推荐";
                overallSummary.put("recommendation", "临床上治疗" + disease + "：用于新品引进时，根据临床是否有替代治疗药物，建议为" + status + "或不推荐；用于药品调出时，根据临床是否有替代治疗药物，建议为暂时保留或调出。");
            }
//            overallSummary.put("recommendation", "临床上治疗"+disease+"时，"+status+"使用"+drugName+"。");
            overallSummary.put("status", status);

            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("max", 25);
            jsonObject1.put("name", "安全性");
            jsonObject1.put("value", result.getJSONObject("safety").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
            JSONObject jsonObject2 = new JSONObject();
            jsonObject2.put("max", 27);
            jsonObject2.put("name", "有效性");
            jsonObject2.put("value", result.getJSONObject("effectiveness").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
            JSONObject jsonObject3 = new JSONObject();
            jsonObject3.put("max", 28);
            jsonObject3.put("name", "药学特性");
            jsonObject3.put("value", result.getJSONObject("pharmaceuticalCharacteristics").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
            JSONObject jsonObject4 = new JSONObject();
            jsonObject4.put("max", 10);
            jsonObject4.put("name", "其他属性");
            jsonObject4.put("value", result.getJSONObject("otherAttributes").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
            JSONObject jsonObject5 = new JSONObject();
            jsonObject5.put("max", 10);
            jsonObject5.put("name", "经济性");
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        return step;
    }
    public String getDemo(String content,String score) {
        String x = "作为一个医学工作者，我需要你根据我给出的药品信息以及打分规则进行打分返回json格式数据" +
                "json数据包含字段为："+content+"（String类型）和"+score+"（数字或小数类型）\n" +
                "具体格式如下(只是举例，需要满足下列回答格式，回答内容请对应给出的具体问题以及资料)：\n" +
                "回答：{\""+content+"\":\"打分的相关依据\",\""+score+"\":\"分数\"}；严格按照上述格式返回";
        return x;
    }


    

    public void write(String key, Object value, HttpServletResponse response, List<CacheDto> cacheDtos,String description) {
        CacheDto cacheDto = new CacheDto(key, value, description);
        cacheDtos.add(cacheDto);
        try {
            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            String s = extractContent(key, value);
            if (Objects.nonNull(s)) {
                s = s.replaceAll("\n", "\\\\n");
                //需要data: 开头
                response.getWriter().write("data: " + s + "\n\n");
                response.getWriter().flush();
                return;
            }
            Thread.sleep(1000);
        } catch (Exception e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }


    public void writeTrCache(CacheDto cacheDto, HttpServletResponse response) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            String key = cacheDto.getKey();
            Object value = cacheDto.getValue();
            String s = extractTrContent(key, value);
            if (Objects.nonNull(s)) {
                s = s.replaceAll("\n", "\\\\n");
                //需要data: 开头
                response.getWriter().write("data: " + s + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(2000);
        } catch (Exception e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }


    public void writeCache(CacheDto cacheDto, HttpServletResponse response) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            String key = cacheDto.getKey();
            Object value = cacheDto.getValue();
            String s = extractContent(key, value);
            if (Objects.nonNull(s)) {
                s = s.replaceAll("\n", "\\\\n");
                //需要data: 开头
                response.getWriter().write("data: " + s + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(2000);
        } catch (Exception e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }

    public String extractTrContent(String key, Object value) {
        //将key和value变为json格式的字符串
        if (value == null) {
            value = "";
        }
        if (key.contains("Score")) {
            value = formatScore(value.toString());
        }
        if (key.contains("evidenceRecommendationContent") || key.contains("clinicalResearchContent") || key.contains("safetyReevaluationContent")
                || key.contains("economicAdvantageOption")) {
            return "{\"" + key + "\":" + JSONObject.toJSON(value) + "}";
        }
        if (key.contains("Json")) {
            return "{\"" + key + "\":" + JSONObject.toJSON(value) + "}";
        }


        String jsonString = "{\"" + key + "\":\"" + value.toString().replaceAll("\"", "'") + "\"}";
        return jsonString;
    }


    public void writeTitle(String key, Object value, HttpServletResponse response, StringBuilder builder) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            String s = extractContent(key, value);
            if (Objects.nonNull(s)) {
                builder.append(s + ",");
                s = s.replaceAll("\n", "");
                //需要data: 开头
                response.getWriter().write("data: " + s + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(2000);
        } catch (IOException | InterruptedException e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }


    public String extractContent(String key, Object value) {
        //将key和value变为json格式的字符串
        if (value == null) {
            value = "暂无内容";
        }
        if (key.contains("Score")) {
            value = formatScore(value.toString());
        }
        if (key.equals("guide")) {
            return "{\"" + key + "\":" + JSONObject.toJSON(value) + "}";
        }

        value = value.toString().replaceAll("\"", "'");
        String jsonString = "{\"" + key + "\":\"" + value + "\"}";
        return jsonString;
    }

    private void GetSynonyms(String drugName, List<String> drugs, String disease, List<String> diseases) {
        Map<String, String> drugTransMap = new HashMap<>();
//        drugTransMap.put(drugName, getTransDeepl(drugName));
        List<DrugInfoNew> drugInfos = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugs)), DrugInfoNew.class);
        List<String> drugsCopy = new ArrayList<>();
        drugInfos.forEach(DrugInfoNew -> {
            if (StringUtils.isNotBlank(DrugInfoNew.getDrugEn())) {
                drugsCopy.add(DrugInfoNew.getDrugEn());
            }
            if (StringUtils.isNotBlank(DrugInfoNew.getDrugZh())) {
                drugsCopy.add(DrugInfoNew.getDrugZh());
            }
            if (CollUtil.isNotEmpty(DrugInfoNew.getDrugSynonymEn())) {
                drugsCopy.addAll(DrugInfoNew.getDrugSynonymEn());
            }
            if (CollUtil.isNotEmpty(DrugInfoNew.getDrugSynonymZh())) {
                drugsCopy.addAll(DrugInfoNew.getDrugSynonymZh());
            }
        });
        drugs.addAll(drugsCopy.stream().distinct().collect(Collectors.toList()));
        // 获取完同义词
        boolean isUseTransDrug = GetSynonymUtil.getSynonym(drugName, drugs, drugs);
        if (!isUseTransDrug) {
            //翻译词的同义词
            if (StringUtils.isNotBlank(drugTransMap.get(drugName))) {
                drugs.add(drugTransMap.get(drugName));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(drugTransMap.get(drugName));
                drugs.addAll(synonymTrans);
            }
        }
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        Map<String, String> diseaseTransMap = new HashMap<>();
//        diseaseTransMap.put(disease, getTransDeepl(disease));
        // 获取完同义词
        String defaultPrompt = CommonPromptEnum.DISEASE_SPLIT.getDefaultPrompt();
//        String gpt = getGpt(defaultPrompt + disease, null);
//        diseases.add(gpt);
        boolean isUseTransDisease = GetSynonymUtil.getSynonym(disease, diseases, diseases);
//        boolean isUseTransDiseasex = GetSynonymUtil.getSynonym(gpt, diseases, diseases);
        if (!isUseTransDisease) {
            //翻译词的同义词
            if (StringUtils.isNotBlank(diseaseTransMap.get(disease))) {
                diseases.add(diseaseTransMap.get(disease));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(diseaseTransMap.get(disease));
                diseases.addAll(synonymTrans);
            }
        }

        diseases = diseases.stream().distinct().collect(Collectors.toList());
    }



    public void getExcel(HttpServletResponse response) {
    }


    private void addScore(TrInfoDto trInfoDto) {
        trInfoDto.getTrClinicalEvaluationDto().setTotalScore();
        trInfoDto.getTrMarketEvaluationDto().setPolicyAttributeScore();
        trInfoDto.getTrMarketEvaluationDto().setTotalScore();
        trInfoDto.getTrInheritanceEvaluationDto().setTotalScore();
        trInfoDto.getTrSafetyEvaluationDto().setCrowdRestrictionScore();
        trInfoDto.getTrSafetyEvaluationDto().setSafetyInfoScore();
        trInfoDto.getTrSafetyEvaluationDto().setTotalScore();
        trInfoDto.getTrTechnologyEvaluationDto().setSuitabilityScore();
        trInfoDto.getTrTechnologyEvaluationDto().setAdditionalZodiacScore();
        trInfoDto.getTrTechnologyEvaluationDto().setTotalScore();
        trInfoDto.setTotalScore();
    }


}
