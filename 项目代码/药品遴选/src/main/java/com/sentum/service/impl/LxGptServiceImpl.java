package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.*;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.github.rholder.retry.RetryException;
import com.github.rholder.retry.Retryer;
import com.sentum.infrastructure.config.ThreadPoolConfig;
import com.sentum.constants.CommonConstants;
import com.sentum.enums.CacheNameEnum;
import com.sentum.enums.CommonPromptEnum;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.feign.EvidenceFeign;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.FormulaFeign;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.*;
import com.sentum.pojo.dto.DrugAddDto;
import com.sentum.pojo.dto.DrugDataInfoDto;
import com.sentum.pojo.dto.GuideDto;
import com.sentum.pojo.vo.*;
import com.sentum.service.*;
import com.sentum.util.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;

import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.FieldValueFactorFunctionBuilder;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;


import java.awt.*;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.util.*;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.locks.Lock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
public class LxGptServiceImpl implements LxGptService {
    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    RedisTemplate<String, Object> redisTemplate;
    @Autowired
    ERNIE_Bot ernie_bot;
    @Autowired
    EvaluationService evaluationService;

    @Qualifier(ThreadPoolConfig.SU_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor threadPoolTaskExecutor;

    @Autowired
    FineScreenFeign fineScreenFeign;

    @Qualifier(ThreadPoolConfig.GUIDE_ANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor guideAnalysisThreadPool;

    @Qualifier(ThreadPoolConfig.MAIN_GPTANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor gptAnalysisThreadPool;
    @Autowired
    private EvidenceFeign evidenceFeign;
    @Autowired
    private MedicineFeign medicineFeign;
    @Autowired
    private FormulaFeign formulaFeign;
    @Autowired
    private GptUtil gptUtil;
    @Autowired
    private GptCallUtil gptCallUtil;

    @Autowired
    private GuideSearch guideSearch;

    @Autowired
    private DrugInfoUtil drugInfoUtil;

    @Value("${gpt.isNew}")
    private boolean isNew;

    @Autowired
    private GptAiUtils gptAiUtils;

    private static final String URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    // 定义线程池参数
    int corePoolSize = 20; // 核心线程数
    int maximumPoolSize = 50; // 最大线程数
    long keepAliveTime = 5000; // 空闲线程存活时间，单位毫秒
    TimeUnit unit = TimeUnit.MILLISECONDS; // 时间单位
    BlockingQueue<Runnable> workQueue = new LinkedBlockingQueue<>(200); // 任务队列

    ThreadPoolExecutor executor = new ThreadPoolExecutor(
            corePoolSize,
            maximumPoolSize,
            keepAliveTime,
            unit,
            workQueue,
            new ThreadPoolExecutor.CallerRunsPolicy()
    );

    private final static Integer GPT_REDIS_TIME = 24;
    private final static String GPT_REDIS_KEY = "evaluation_gpt_score:";

    private String getGptRedis(String md5) {
        String key = GPT_REDIS_KEY + md5;
        if (redisTemplate.hasKey(key)) {
            String s = (String) redisTemplate.opsForValue().get(key);
            redisTemplate.expire(key, GPT_REDIS_TIME, TimeUnit.HOURS);
            return s;
        }
        return "";
    }


    String regEx_script = "<script[^>]*?>[\\s\\S]*?<\\/script>";// 定义script的正则表达式

    String regEx_style = "<style[^>]*?>[\\s\\S]*?<\\/style>";// 定义style的正则表达式

    String regEx_html = "<[^>]+>";// 定义HTML标签的正则表达式


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


    public Double getThirdCharacterAsArabic(String input) {
        // 检查字符串长度
        return DIGIT_MAP.get(input);
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


    private final Map<String, Lock> lockMap = new ConcurrentHashMap<>();


    private String youyideyi(String msg, JSONObject responseFormat, String model) {
        log.info("*****************youyideyi msg:{}*************", msg);
        String cleanedText = msg.replaceAll("[^\\p{L}\\p{N}\\p{IsHan}]+", "");
        cleanedText = cleanedText + responseFormat + model;
        String md5 = SecurityUtil.getMd5(cleanedText);
        String gptRedis = getGptRedis(md5);
        if (StringUtils.isNotEmpty(gptRedis)) {
            return gptRedis;
        }

        // 获取当前 md5 对应的锁
        // Lock lock = lockMap.computeIfAbsent(md5, k -> new ReentrantLock());
        // lock.lock();
        try {
            // 再次检查缓存是否存在，防止并发下重复计算
            gptRedis = getGptRedis(md5);
            if (StringUtils.isNotEmpty(gptRedis)) {
                return gptRedis;
            }

            long ts = System.currentTimeMillis();
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
            jsonObject1.put("model", model);
            jsonObject1.put("responseFormat", responseFormat);

            String response = null;
            try {
                Retryer retryer = GuavaRetryer.createRetryer();
                response = (String) retryer.call(() -> gptUtil.generation(jsonObject1));

                String requestBody = jsonObject1.toJSONString();
                int length = response.length();
                int length1 = response.getBytes("UTF-8").length;

                int requestCharCount = requestBody.length() + length;
                int requestByteCount = requestBody.getBytes("UTF-8").length + length1;

                // 更新 Redis 中模型请求量统计
                updateGptLengthAndBytes(model, requestByteCount);

            } catch (Exception e) {
                log.error(e.getMessage() + "*********gpt调用失败*************prompt:" + msg, e);
            }

            log.info("call gpt cost time:{}", System.currentTimeMillis() - ts);

            if (StringUtils.isNotEmpty(response)) {
                // 清洗响应内容
                String cleanedResponse = response
                        .replaceAll("\\uFFFD", "")
                        .replaceAll("\\\\n", "")
                        .replaceAll("\\*", "")
                        .replaceAll("#", "")
                        .replaceAll("(?<!\\\\)(\\\\[^\\\\n])|\\\\", "")
                        .replaceAll("[\r\n]", "");

                // String key = GPT_REDIS_KEY + md5;
                // redisTemplate.opsForValue().set(key, cleanedResponse, 24, TimeUnit.HOURS);
                return cleanedResponse;
            }
            return "";
        } finally {
            // lock.unlock(); // 释放锁
        }
    }

    // 抽离更新统计逻辑
    private void updateGptLengthAndBytes(String model, int requestByteCount) {
        String lenKey = "GPT_len:" + model;
        String btKey = "GPT_bt:" + model;

        String o = (String) redisTemplate.opsForValue().get(lenKey);
        long len = StringUtils.isNotBlank(o) ? Long.parseLong(o) : 0;
        redisTemplate.opsForValue().set(lenKey, (len + requestByteCount) + "");

        String o1 = (String) redisTemplate.opsForValue().get(btKey);
        long bt = StringUtils.isNotBlank(o1) ? Long.parseLong(o1) : 0;
        redisTemplate.opsForValue().set(btKey, (bt + requestByteCount) + "");
    }


    private String youyideyiOld(String msg) {
        log.info("*****************youyideyi msg:{}*************", msg);
        String cleanedText = msg.replaceAll("[^\\p{L}\\p{N}\\p{IsHan}]+", "");
        String md5 = SecurityUtil.getMd5(cleanedText);
        String gptRedis = getGptRedis(md5);
        if (StringUtils.isNotEmpty(gptRedis)) {
            return gptRedis;
        }

        // 获取当前 md5 对应的锁
        // Lock lock = lockMap.computeIfAbsent(md5, k -> new ReentrantLock());
        // lock.lock();
        try {
            // 再次检查缓存是否存在，防止并发下重复计算
            gptRedis = getGptRedis(md5);
            if (StringUtils.isNotEmpty(gptRedis)) {
                return gptRedis;
            }

            long ts = System.currentTimeMillis();
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
            //["gpt-3.5-turbo","gpt-4-0613"]
//        jsonObject1.put("model", "gpt-4-0613");  // 112068
//        jsonObject1.put("model", "gpt-3.5-turbo");  // 慢  105605
            //      jsonObject1.put("model", "gpt-4");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-3.5-turbo-16k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-4-32k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
            jsonObject1.put("model", "gpt-4o-mini");
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
                response = response.replaceAll("#", "");
                String s = response.replaceAll("[\r\n]", "");
                String key = GPT_REDIS_KEY + md5;
                // redisTemplate.opsForValue().set(key, s, 24, TimeUnit.HOURS);
                return s;

            }
            return "";
        } finally {
            // lock.unlock(); // 释放锁
        }
    }

    private String xiaoling(String search, String prompt) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("prompt", prompt + "(中文一句话返回)");
        jsonObject.put("word", search);
        String s;
        try {
            s = medicineFeign.gptForPharmacy(jsonObject);
        } catch (Exception e) {
            s = youyideyiOld("请检索" + search + "的相关信息，" + prompt);
        }

        log.info("小灵返回{}", s);
        return s.replaceAll("\n", "");
    }

    private String chat(String msg) {
//        log.info("query:{}",msg);
        try {
            return youyideyiOld(msg);
            // return ernie_bot.chat(msg);
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
            // return ernie_bot.chat(msg);
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
            return executeGpt(finalQuery, "adrs","");
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
            return executeGpt(query, "guideAdrsScore",null);
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
            return executeGpt(finalQuery, "adverseReactionAnalysis",null);
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
            return executeGpt(query, "specialCrowdAnalysis","");
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
            return executeGpt(query, "specialCrowdScore","");
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
            return executeGpt(query, "drugInteractionAnalysis","3,2,1");
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
            return executeGpt(query, "otherAdverseReactionAnalysis","3,2,1");
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
            return executeGpt(query, "guideAdrsInfo_v2", "");
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
            return executeGpt(queryAdd + query, "sameClass", "4,0");
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
            return executeGpt(finalQuery, "specialCrowd",null);
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
           return gptAiUtils.executeGptPlus(finalQuery,"通过适应症进行评分", getDemo("process","score"),"", "5,3,1");
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
            return executeGpt(query, "clinicalEffect","");
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
            return executeGpt(query, "literatureAnalysis", "");
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
            return executeGpt(query, "guideEffective", "");
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
            return executeGpt(query, "guideEffective","");
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
        // 使用方法/依从性
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
        // 贮藏条件
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
        // 若为复方制剂，其复方成分及配比是否规范
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
        // 使用方法/依从性
        String query1 = "你现在是一个专业药师，请对" + drugName + "的使用方法进行打分，打分标准如下：" +
                "1、规格、剂型等适宜，使用方便，依从性好得4分；" +
                "2、规格、剂型等适宜欠佳，使用不便，依从性差得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的使用方法，字段都是整数格式";
        // 贮藏条件
        String query2 = "你现在是一个专业药师，请对" + drugName + "的贮藏条件进行打分，打分标准如下：" +
                "1、无特殊储存要求得4分；" +
                "2、有特殊储存要求比如指温度（冷藏、冷冻）、光线（避光、遮光）等得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的贮藏条件（注意使用文本格式），字段都是整数格式";
        // 若为复方制剂，其复方成分及配比是否规范
        String query3 = "你现在是一个专业药师，请对" + drugName + "的复方成分进行打分，打分规则如下：" +
                "1、如果是复方成分及配比均规范得6分；" +
                "2、若为单方制剂，则直接得6分；" +
                "3、其他得0分。" +
                "请严格使用JSON格式进行回答score为得分，reason为理由，msg为文本格式的药品成分（注意使用文本格式），字段都是整数格式";
        // 皮试要求
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
            return executeGpt(query, "pharmacy","");
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
        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "pharmacyScore","");
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
        // String query =  "问题1：介绍"+enterpirceName+"并给出其在制药企业或工信部医药工业百强榜企业中的排名情况。";
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


    private JSONObject executeGpt(String query, String name,String score) {
        JSONObject jsonObject = new JSONObject();
        if (StringUtils.isNotEmpty(score)){
            String[] split = score.split(",");
            String list = Arrays.stream(split).map(item -> "\"" + item + "\"").collect(Collectors.joining(","));
            query += "*****得分相关的返回项必须从"+list+"中选择，不可以出现不存在的数值";
        }
        String result = youyideyiOld(query);
        log.info(name + "进行了分析");
        log.info("GPT分析的问题是:{}", query);
        log.info("----经过GPT分析出来的结果是{}", result);
        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
        return jsonObject;
    }

    public JSONObject executeGptPlus(String query, String name, JSONObject jsonObject1, String model,String score) {
        JSONObject jsonObject = new JSONObject();
        String modelName = model;
        if (StringUtils.isEmpty(model)) {
            modelName = "gpt-4o-mini";
        }

        if (StringUtils.isNotEmpty(score)){
            String[] split = score.split(",");
            //数组转为可视化的list
            String list = Arrays.stream(split).map(item -> "\"" + item + "\"").collect(Collectors.joining(","));
            query += "*****得分相关的返回必须是"+list+"中的某个数值，不可以出现不存在的数值，你给我返回的结果中，除了得分之外，分析结果中请不要包含根据我给出的哪一条规则判断给出的评分，这样的字眼，直接输出相关分析结果就好。如：‘在评分规则第（6）项中已经指示将其视为西医病。’\\n 还有若出现null则表示无相关信息，无视即可，不要返回null相关字眼";
        }
        String result = youyideyi(query, jsonObject1, modelName);

        JSONObject object = new JSONObject();
        object.put("result", result);
        object.put("query", query);
        object.put("model", modelName);
        object.put("name", name);
        mongoTemplate.save(object, "gpt_demo");

        log.info(name + "进行了分析");
        log.info("GPT分析的问题是:{}", query);
        log.info("----经过GPT分析出来的结果是{}", result);

        if (result.contains("[") && result.contains("]")) {
            try {
                int start1 = result.indexOf('[');
                int end1 = result.lastIndexOf(']');
                JSONArray objects = JSONObject.parseArray(result.substring(start1, end1 + 1));
                jsonObject.put("array", objects);
                return jsonObject;
            } catch (Exception e) {
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                try {
                     jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
                    return jsonObject;
                } catch (Exception ex) {

                    try {
                        String result1 = youyideyi(query + "***************严格以json格式返回*************", jsonObject1, modelName);
                        log.info(name + "进行了分析");
                        log.info("GPT分析的问题是:{}", query);
                        log.info("----经过GPT分析出来的结果是{}", result);
                        jsonObject = JSONObject.parseObject(result1.substring(start, end + 1));
                        return jsonObject;
                    } catch (Exception exc) {

                    }
                }
            }

        }


        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        try {
            jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
        } catch (Exception e) {

            try {
                String result1 = youyideyi(query + "***************严格以json格式返回*************", jsonObject1, modelName);
                log.info(name + "进行了分析");
                log.info("GPT分析的问题是:{}", query);
                log.info("----经过GPT分析出来的结果是{}", result);
                jsonObject = JSONObject.parseObject(result1.substring(start, end + 1));
            } catch (Exception ex) {

            }

        }

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
    public JSONObject pharmacology(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StringUtils.isEmpty(drugInfo.getPharmacology())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的作用机制是什么", "药物作用机制");
                drugInfo.setPharmacology(s);
            } catch (Exception e) {
                log.error("作用机制获取失败", e);
            }
        }
        if (StrUtil.isNotBlank(drugInfo.getPharmacology())) {
            query = "请你作为一名专业的临床药师，针对说明书中的药理作用：\"" + drugInfo.getPharmacology() +
                    "\"结合一下规则评分规则，针对给出的药理作用结果进行打分。" +
                    "注意：请单选。5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。 " +
                    "4分：临床疗效确切，作用机制明确。 " +
                    "2分：临床疗效尚可，作用机制尚不明确。 " +
                    "1分：临床疗效一般，作用机制不明确。" +
                    "注意：只能单选，分值必须是规则中的分值，不得超出范围。";
        } else {
            query = "请你以一名专业的药学科研人员的身份，分析" + drugName + "在治疗" + disease + "的药理作用如何。再根据以下评分规则，针对给出的药理作用结果进行打分。" +
                    "注意，请单选。5分：临床疗效确切，作用机制明确，作用机制或作用靶点有创新性。 " +
                    "4分：临床疗效确切，作用机制明确。 " +
                    "2分：临床疗效尚可，作用机制尚不明确。 " +
                    "1分：临床疗效一般，作用机制不明确。" +
                    "注意：只能单选，分值必须是规则中的分值，不得超出范围。";
        }
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "pharmacology", getDemo("process","score"), "","5,4,3,2,1,0");
            }else {
                return executeGptPlus(finalQuery, "pharmacology", responseFormat, "", "5,4,3,2,1,0");
            }
        });
    }

    /***
     * 药学特性--药理作用分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    public JSONObject pharmacokinetics(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StringUtils.isEmpty(drugInfo.getPharmacokinetics())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的药代动力学机制是什么", drugName + "药代动力学机制");
                drugInfo.setPharmacokinetics(s);
            } catch (Exception e) {
                log.error("药代动力学获取失败", e);
            }
        }
        if (StrUtil.isNotBlank(drugInfo.getPharmacokinetics())) {
            query = "请你作为一名专业的临床药师，针对说明书中的药代动力学：" + drugInfo.getPharmacokinetics() + "\n" +
                    "请根据以下评分规则，针对给出的说明书中药代动力学内容进行打分。" +
                    "请单选（并且最终得分只能为5或3或1，不得自创分值）。" +
                    "5分：体内过程明确，药代动力学参数完整。" +
                    "3分：体内过程明确，药代动力学参数不完整。" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。";
        } else {
            query = "请你以一名专业的药学科研人员的身份，分析" + drugName + "在治疗" + disease + "的体内过程（药代动力学）如何。" +
                    "再根据以下评分规则，针对给出的体内过程（药代动力学）结果进行打分。" +
                    "分析过程中需要包含体内过程或药代动力学具体是什么，然后再给出分析结果。" +
                    "注意，请单选（并且最终得分只能为5或3或1，不得自创分值）。" +
                    "5分：体内过程明确，药代动力学参数完整。" +
                    "3分：体内过程明确，药代动力学参数不完整。" +
                    "1分：体内过程尚不明确，或无药代动力学相关研究。";
        }
        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "pharmacokinetics", getDemo("process","score"), "","5,3,1");
            }else {
                return executeGptPlus(finalQuery, "pharmacokinetics", responseFormat, "", "5,3,1");
            }});
    }

    /***
     * 药学特性--药剂学和使用方法分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    public JSONObject usageAndDosage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StringUtils.isEmpty(drugInfo.getIngredient())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的主要成分是什么，辅料是什么", "药物成分");
                String s1 = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的用法用量", "用法用量");
                drugInfo.setIngredient(s);
                drugInfo.setUsageAndDosage(s1);

            } catch (Exception e) {
                log.error("主要成分获取失败", e);
            }
        }
        if (StrUtil.isNotBlank(drugInfo.getUsageAndDosage())) {
            query = "请你作为一名专业的临床药师，针对说明书中相关内容，分别分析以下内容(打分与说明不要前后矛盾)：" +
                    "返回参数scoreA（打分）和processA（原因）" +
                    "**********问题A：请分析一下" + drugName + "的主要成分与辅料是否明确，需要根据提供的成分信息进行真实描述，不要猜测结果。相关成分信息：" + drugInfo.getIngredient() + ";" +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "2分：主要成分与辅料均明确。" +
                    "1分：主要成分明确或辅料明确。" +
                    "********问题B：请分析一下" + drugName + "的规格与包装是否适宜临床使用，在临床中是否需要针对不同人群或疾病需要进行剂量调整，" +
                    "药品规格信息" + drugInfo.getSpecifications() + ";" + "包装信息:" + drugInfo.getPack() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreB（打分）和processB（原因）" +
                    "2分：规格与包装均适宜临床应用/剂量调整。" +
                    "1分：规格或包装适宜临床应用/剂量调整。" +
                    "*************问题C：请分析一下" + drugName + "的剂型是什么，" + "剂型信息：" + drugInfo.getDosageForm() + "，" +
                    "并根据以下评分规则给予一个得分（注意：若药品存在多个给药途径时，分值采用就高原则）：" +
                    "返回参数scoreC（打分）和processC（原因）" +
                    "2分：口服制剂/吸入制剂/外用制剂。" +
                    "1.5分：皮下注射剂/肌内注射剂。" +
                    "1分：静脉滴注/静脉注射剂。\n" +
                    "*********问题D：请分析一下" + drugName + "在治疗" + disease + "时的给药剂量，是固定给药剂量，还是需要根据体质量或体表面积计算后调整给药剂量，" +
                    "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreD（打分）和processD（原因）" +
                    "2分：给药剂量固定。" +
                    "1.5分：使用过程中需调整给药剂量。" +
                    "1分：根据体质量或体表面积计算用药剂量。" +
                    "***********问题E：请分析一下" + drugName + "在治疗" + disease + "时的给药频次如何，单选" +
                    "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreE（打分）和processE（原因）" +
                    "2分：给药频次适宜，如≤1次·d^-1。" +
                    "1.5分：给药频次适宜，如2次·d^-1。" +
                    "1分：给药频次适宜，如≥3次·d^-1。" +

                    "*******问题F：请评价" + drugName + "在使用过程中的便利性，是否需要他人帮助或训练后才能自行给药，或者不可自行给药，需要医务人员辅助，" +
                    "并根据以下评分规则给予一个得分：" +
                    "返回参数scoreF（打分）和processF（原因）" +
                    "2分：使用方便，无需辅助，可自行给药。" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                    "1分：使用较为繁琐，需医务人员给药。" +
                    "请注意：" +
                    "（1）如果患者能自行服药，直接给2分。如口服制剂与外用制剂等。" +
                    "（2）如果是吸入剂，部分吸入剂器械的使用可能需要医护人员指导后使用，给1.5分。" +
                    "（3）如果是需要医护人员帮助才能用药的情况，给1分，如注射用药。" +
                    "（4）你需要根据我提供给你的用法用量信息或者你自己的知识库信息加以判断，以上三项并不是严格标准。" +

                    "提供的说明书中相关资料如下：" + drugInfo.getUsageAndDosage() + "；" + drugInfo.getIngredient() + "；" + drugInfo.getPack() + "；" + drugInfo.getSpecificationsIns();
        } else {
            query = "请你作为一名专业的临床药师，针对说明书中相关内容，分别分析以下内容(打分与说明不要前后矛盾)：" +
                    "返回参数scoreA（打分）和processA（原因）" +
                    "**********问题A：请分析一下" + drugName + "的主要成分与辅料是否明确，需要根据提供的成分信息进行真实描述，不要猜测结果。相关成分信息：" + drugInfo.getIngredient() + ";" +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "2分：主要成分与辅料均明确。" +
                    "1分：主要成分明确或辅料明确。" +
                    "********问题B：请分析一下" + drugName + "的规格与包装是否适宜临床使用，在临床中是否需要针对不同人群或疾病需要进行剂量调整，" +
                    "药品规格信息" + drugInfo.getSpecifications() + ";" + "包装信息:" + drugInfo.getPack() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreB（打分）和processB（原因）" +
                    "2分：规格与包装均适宜临床应用/剂量调整。" +
                    "1分：规格或包装适宜临床应用/剂量调整。" +
                    "*************问题C：请分析一下" + drugName + "的剂型是什么，" + "剂型信息：" + drugInfo.getDosageForm() + "，" +
                    "并根据以下评分规则给予一个得分（注意：若药品存在多个给药途径时，分值采用就高原则）：" +
                    "返回参数scoreC（打分）和processC（原因）" +
                    "2分：口服制剂/吸入制剂/外用制剂。" +
                    "1.5分：皮下注射剂/肌内注射剂。" +
                    "1分：静脉滴注/静脉注射剂。\n" +
                    "*********问题D：请分析一下" + drugName + "在治疗" + disease + "时的给药剂量，是固定给药剂量，还是需要根据体质量或体表面积计算后调整给药剂量，" +
                    "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreD（打分）和processD（原因）" +
                    "2分：给药剂量固定。" +
                    "1.5分：使用过程中需调整给药剂量。" +
                    "1分：根据体质量或体表面积计算用药剂量。" +
                    "***********问题E：请分析一下" + drugName + "在治疗" + disease + "时的给药频次如何，单选" +
                    "用法用量相关信息:" + drugInfo.getUsageAndDosage() +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "返回参数scoreE（打分）和processE（原因）" +
                    "2分：给药频次适宜，如≤1次·d^-1。" +
                    "1.5分：给药频次适宜，如2次·d^-1。" +
                    "1分：给药频次适宜，如≥3次·d^-1。" +

                    "*******问题F：请评价" + drugName + "在使用过程中的便利性，是否需要他人帮助或训练后才能自行给药，或者不可自行给药，需要医务人员辅助，" +
                    "并根据以下评分规则给予一个得分：" +
                    "返回参数scoreF（打分）和processF（原因）" +
                    "2分：使用方便，无需辅助，可自行给药。" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                    "1分：使用较为繁琐，需医务人员给药。" +
                    "请注意：" +
                    "（1）如果患者能自行服药，直接给2分。如口服制剂与外用制剂等。" +
                    "（2）如果是吸入剂，部分吸入剂器械的使用可能需要医护人员指导后使用，给1.5分。" +
                    "（3）如果是需要医护人员帮助才能用药的情况，给1分，如注射用药。" +
                    "（4）你需要根据我提供给你的用法用量信息或者你自己的知识库信息加以判断，以上三项并不是严格标准。";
        }
        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("scoreA", "问题A得分(阿拉伯数字)");
        stringStringHashMap.put("scoreB", "问题B得分(阿拉伯数字)");
        stringStringHashMap.put("scoreC", "问题C得分(阿拉伯数字)");
        stringStringHashMap.put("scoreD", "问题D得分(阿拉伯数字)");
        stringStringHashMap.put("scoreE", "问题E得分(阿拉伯数字)");
        stringStringHashMap.put("scoreF", "问题F得分(阿拉伯数字)");

        stringStringHashMap.put("processA", "问题A描述,打分scoreA的描述");
        stringStringHashMap.put("processB", "问题B描述,打分scoreB的描述");
        stringStringHashMap.put("processC", "问题C描述,打分scoreC的描述");
        stringStringHashMap.put("processD", "问题D描述,打分scoreD的描述");
        stringStringHashMap.put("processE", "问题E描述,打分scoreE的描述");
        stringStringHashMap.put("processF", "问题F描述,打分scoreF的描述");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGptPlus(finalQuery, "usageAndDosage", responseFormat, "",null);
        });
    }

    /***
     * 药学特性--贮藏条件分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    public JSONObject storage(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isBlank(drugInfo.getStorage())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "贮存时的要求是什么？", "贮藏要求");
                drugInfo.setStorage(s);
            } catch (Exception e) {
                log.error("检索贮存失败");
            }
        }
        if (StrUtil.isNotBlank(drugInfo.getStorage())) {
            query = "请你作为一名专业的临床药师，针对说明书中的储藏条件：" + drugInfo.getStorage() + "\n" +
                    "请根据以下储藏条件的定义、注意事项，分析" + drugName + "的储藏条件，结合以下评分规则给出一个最终得分：" +
                    "常温、阴凉、冷藏的定义如下：" +
                    "温度值在8.001-20℃时，视为阴凉处。" +
                    " 2-8℃视为冷藏。" +
                    " 温度值在10-30℃时，视为常温。说明书贮藏条件中没有提到温度，视为常温贮藏。" +
                    " 注意：" +
                    " 若储藏条件中没有明确提到“遮光”或“避光”的字眼，或者明确说明无需遮光或无需避光，请额外再加1分；" +
                    " 若储藏条件中明确提到“遮光”或“避光”的字眼，或者明确说明需遮光或需避光，请不要额外加1分；" +
                    " 分析结果请严格采用JSON格式返回。" +
                    "根据以上定义、注意事项以及以下规则给出一个最终得分：" +
                    "3分：常温贮藏，且需要遮光/避光" +
                    "2分：阴凉贮藏，且需要遮光/避光" +
                    "1分：冷藏/冷冻贮藏，且需要遮光/避光" +
                    "4分：常温贮藏，不需要遮光或不需要避光";
        } else {
            query =
                    "请你作为一名专业的临床药师,根据以下储藏条件的定义、注意事项，分析" + drugName + "的储藏条件，结合以下评分规则给出一个最终得分：" + "常温、阴凉、冷藏的定义如下：" +
                            "温度值在8.001-20℃时，视为阴凉处。" +
                            " 2-8℃视为冷藏。" +
                            " 温度值在10-30℃时，视为常温。说明书贮藏条件中没有提到温度，视为常温贮藏。" +
                            " 注意：" +
                            " 若储藏条件中没有明确提到“遮光”或“避光”的字眼，或者明确说明无需遮光或无需避光，请额外再加1分；" +
                            " 若储藏条件中明确提到“遮光”或“避光”的字眼，或者明确说明需遮光或需避光，请不要额外加1分；" +
                            " 分析结果请严格采用JSON格式返回。" +
                            "根据以上定义、注意事项以及以下规则给出一个最终得分：" +
                            "3分：常温贮藏，且需要遮光/避光" +
                            "2分：阴凉贮藏，且需要遮光/避光" +
                            "1分：冷藏/冷冻贮藏，且需要遮光/避光" +
                            "4分：常温贮藏，不需要遮光或不需要避光" +
                            "分析结果请严格采用JSON格式返回。";
        }
        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "得分(只要阿拉伯数字)");
        stringStringHashMap.put("process", "储藏条件的分析过程");

        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {

            if(isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "storage", getDemo("process","score"), "","4,3,2,1,0");
            }else {
                return executeGptPlus(finalQuery, "storage", responseFormat, "","4,3,2,1,0");
            }


        });
    }

    /***
     * 药学特性--有效期分析
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     * @return 每项药学特性进行评分
     */
    public JSONObject indate(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
        String query = "";
        if (StrUtil.isBlank(drugInfo.getIndate())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "有效期有多长？", "有效期");
                drugInfo.setIndate(s);
            } catch (Exception e) {
                log.error("检索有效期失败");
            }
        }
        if (StrUtil.isNotBlank(drugInfo.getIndate())) {
            query = "请你作为一名专业的临床药师，针对说明书中的有效期：" + drugInfo.getIndate() + "\n" +
                    "请根据以下规则给予一个得分(若说明书中不同规格存在多个有效期导致最终评分不同时，先取有效期时间长的那个分值)：\n" +
                    "2分：有效期≥60个月。\n" +
                    "1.5分：有效期≥36个月，＜60个月。\n" +
                    "1分：有效期≥24个月，＜36个月。\n" +
                    "0.5分：有效期≥12个月，＜24个月。12个月也算0.5分。\n" +
                    "0.25分：有效期＜12个月。\n" +
                    "此处提供有效期有可能出现书写不全的问题，请你按照常规药品的有效期推测补全后再进行打分，比如：”多少个“补全为”多少个月\n";
        } else {
            query = "请分析" + drugName + "的有效期是多长时间，并根据以下规则给予一个得分(若有多个有效期，以有效期较短为准，只进行一次评分)：\n" +
                    "2分：有效期≥60个月。\n" +
                    "1.5分：有效期≥36个月，＜60个月。\n" +
                    "1分：有效期≥24个月，＜36个月。\n" +
                    "0.5分：有效期≥12个月，＜24个月。12个月也算0.5分。\n" +
                    "0.25分：有效期＜12个月。\n" +
                    "注意：'score' 请不要给出 '无法给出具体得分' 这样的话，若因无法给出药品的具体有效期数据而无法打分，" +
                    "请根据药品的平均有效期，最终得分请给出一个最终得分；或者直接给出最低分0.25。";
        }
        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);


        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            if(isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "indate", getDemo("process","score"), "","2,1.5,1,0.5,0.25");
            }else {
            return executeGptPlus(finalQuery, "indate", responseFormat, "","2,1.5,1,0.5,0.25");}
        });
    }

    /***
     * 有效性--适应症
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param drugInfo 药品信息
     */
    private JSONObject indication(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
//        if (StrUtil.isNotBlank(drugInfo.getIndication())) {
        String doc = xiaoling(drugName, "请分析一下在临床研究中，在治疗" + disease + "的药品除了" + drugName + "还有哪些？返回结果请这样回答：治疗" + disease + "除了" + drugName + "还有...（总结一句话返回）");
        Retryer retryer = GuavaRetryer.createRetryer();
//        if (StrUtil.isNotBlank(drugInfo.getIndication())) {
        query = "请根据我提供如下内容：" + doc + "，判断临床上" + drugName + "治疗" + disease + "时，属于临床必需首选药品，或者是临床必需次选药品，还是可选药品较多？" + "\n" +
                "请基于以下评分标准给出最终的评分。" +
                " 在判断某药品针对某疾病进行临床治疗情况时：" +
                "（1）首先判断此药品治疗此疾病是否是临床一线治疗药品或首选治疗方案，若是给5分，若不是，进行第二条判断；" +
                "（2）判断药品治疗疾病是否是临床二线治疗药品，若是给3分，若不是，进行第三条判断；" +
                "（3）不满足以上两条，给1分。 " +
                "注意：分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为" + drugName + "治疗" + disease + "的分析过程。";
//        } else {
//            query = "请分析一下在临床研究中，在治疗" + disease + "的药品有哪些？" + drugName + "在治疗" + disease + "是临床必需首选药品/临床必需次选药品/可选药品较多？"  + "\n" +
//                    "基于以下评分标准给出最终的评分。" +
//                    "注意，请单选。'score' 中只显示数值即可。" +
//                    "1、临床必需，首选药品 得分5分；" +
//                    "2、临床必需，次选药品 得分3分；" +
//                    "3、可选药品较多 得分1分。" +
//                    "分析结果请严格采用JSON格式返回。" +
//                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
//        }
        // GPT3.5


        String finalQuery = queryAdd + query;
        JSONObject indication1 = (JSONObject) retryer.call(() -> {
            return gptAiUtils.executeGptPlus(finalQuery, " indications", getDemo("process","score"), "", "5,3,1");
        });
        indication1.put("process", doc + indication1.getString("process"));
        return indication1;
    }


    private JSONObject indicationPc(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
//        if (StrUtil.isNotBlank(drugInfo.getIndication())) {
        if (StringUtils.isEmpty(drugInfo.getIndicationx())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的适应症是什么?", "适应症");
                drugInfo.setIndicationx(s);
            } catch (Exception e) {
                log.error("适应症检索失败！");
            }
        }
        String doc = drugInfo.getIndicationx();

        String x = "";


        Retryer retryer = GuavaRetryer.createRetryer();
//        if (StrUtil.isNotBlank(drugInfo.getIndication())) {
        query = "你作为一名专业的西药的临床药师，非常熟悉药品在临床中所处的地位。请结合我提供的指南以及你自己的知识库，评判下在治疗在" + disease + "的临床常用治疗方案中，" + drugName + "所处的临床定位" + "\n" +
                "请结合以下评分标准给出最终的评分。（单选）" +
                "（1）首先判断目标药品治疗目标疾病时，是否是临床一线治疗药品，或者首选治疗方案，或者无其他可替代治疗方案，若是给5分，若不是，进行第二条判断；" +
                "（2）判断目标药品在临床上用于治疗目标疾病时，属于临床必需，但是治疗目标疾病还有很多其他可以替代的治疗方案；在治疗目标疾病时，这个药品一版不作为不作为临床首选药品，若是给3分，若不是，进行第三条判断；" +
                "（3）不满足以上两条，给1分。 " +
                "注意：" +
                "（1）分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "（2）" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为" + drugName + "治疗" + disease + "的分析过程。" +
                "'''" +
                "指南标题+原文文本块（纳入逻辑：药品名称与疾病名称同时出现在指南标题或者文本块中）" +
                "'''";
//        } else {
//            query = "请分析一下在临床研究中，在治疗" + disease + "的药品有哪些？" + drugName + "在治疗" + disease + "是临床必需首选药品/临床必需次选药品/可选药品较多？"  + "\n" +
//                    "基于以下评分标准给出最终的评分。" +
//                    "注意，请单选。'score' 中只显示数值即可。" +
//                    "1、临床必需，首选药品 得分5分；" +
//                    "2、临床必需，次选药品 得分3分；" +
//                    "3、可选药品较多 得分1分。" +
//                    "分析结果请严格采用JSON格式返回。" +
//                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
//        }
        // GPT3.5


        String finalQuery = queryAdd + query;
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        JSONObject indication1 = (JSONObject) retryer.call(() -> {
            return gptAiUtils.executeGptPlus(finalQuery, " indications", getDemo("process","score"), "", "5,3,1");
        });
        indication1.put("process", indication1.getString("process"));
        return indication1;
    }

    /***
     * 有效性--指南
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param pdf_txt 原文内容
     * @param zdz  制定者
     * @param title  文章标题
     */
    private JSONObject guide(String drugName, String disease, String pdf_txt, String zdz, String title, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        String query = "请作为一名专业的临床药师，善于针对指南与文献内容进行分析。请根据我提供的相关资料，并结合以下评分规则给出最高评分：" +
                "顺序依次往下，等级越低：\n" +
                "诊疗规范（关键词：诊疗规范、指导原则）：12分\n" +
                "临床路径（关键词：临床路径）：12分\n" +
                "国家卫生行政机构发布共识或者管理办法（关键词：制定者中带有“国家”、“国务院”、“中国”、“中华”、“欧洲”、“美国”等代表国家的词）：12分\n" +
                "指南Ⅰ级推荐，且为A级证据（关键词：原文中同时带有“Ⅰ”、“A”字样或者同时带有“Ⅰ级”、“A”字样）：12分\n" +
                "指南Ⅰ级推荐，且为B 级证据（关键词：原文中同时带有“Ⅰ”、“B”字样或者同时带有“Ⅰ级”、“B”字样）：11分\n" +
                "指南Ⅰ级推荐，且为C级证据及其他（关键词：原文中同时带有“Ⅰ”、“C”字样或者同时带有“Ⅰ级”、“C”字样，或者只有“Ⅰ”或者“Ⅰ级”）：10分\n" +
                "指南Ⅱ据及以下推荐，且为A级证据（关键词：原文中同时带有“Ⅱ”、“A”字样或者同时带有“Ⅱ级”、“A”字样）：9分\n" +
                "指南Ⅱ据及以下推荐，且为B级证据（关键词：原文中同时带有“Ⅱ”、“B”字样或者同时带有“Ⅱ级”、“B”字样）：8分\n" +
                "指南Ⅱ据及以下推荐，且为C级证据及其他（关键词：原文中同时带有“Ⅱ”、“C”字样或者同时带有“Ⅱ级”、“C”字样，或者只有“Ⅱ”或者“Ⅱ级”）：7分\n" +
                "由学会组织基于系统评价发布的专家共识推荐（关键词：制定者中带有“学会”且指南基于“Meta分析/系统综述”，但是国家级学会排除，因国家级学会算作“国家卫生行政机构发布共识或者管理办法”）：6分\n" +
                "由学会组织发布的专家共识推荐（关键词：制定者中带有“学会”，但是国家级学会排除，因国家级学会算作“国家卫生行政机构发布共识或者管理办法”）：5分\n" +
                "除了学会组织发布的专家共识之外的其他专家共识（关键词：专家共识，但是需要排除以上的专家共识，如国家级学会或者基于meta分析的专家共识）：4分\n" +
                "请注意：" +
                "（1）分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "（2）只有当提供给你的指南原文中明确了推荐等级时，才可根据评分标准进行打分。不要联网总结指南；" +
                "（3）诊疗规范定义：特指由国家卫健委、原卫生部等国家卫生行政机构出台的相关用药指导性文件，比如《抗菌药物临床应用指导原则》、《新型抗肿瘤药物临床应用指导原则》、《国家基本药物临床应用指南》、《原发性肝癌诊疗规范》等都属于诊疗规范。" +
                "（4）专家共识定义：指由各专业学会制定并发布的专家共识。若为国家政府机构发布的专家共识，则归为诊疗规范。" +
                "（5）结论性话术全部以中文结果输出，不用出现小标题，或者类似XX治疗XX有效性相关结论：等字眼。" +
                "（6）分析结果请严格采用JSON格式返回。且最低打分为4分" +
                "分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为根据原文内容汇总出成一段总结性的话（不要打分内容与理由，总结" + drugName + "治疗" + disease + "相关内容（我给的内容不多，可以的话请检索你的资料库进行总结，若是没有，请按照我给你的内容总结））。" +
                "提供的指南信息如下：\n" +
                "’’’\n" +
                zdz + "发布的《" + title + "》中的原文内容:" + pdf_txt + "\n" +
                "’’’";

        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "guideOrLiterature","12,11,10,9,8,7,6,5,4");
        });
    }


    /***
     * 有效性--指南
     * @param drugName 药品名称
     * @param disease  疾病名称
     * @param title  文章标题
     */
    private JSONObject guidePc(String drugName, String disease, String title, String content, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        String query = "请根据" + title + "中的原文内容:'" + content + "'" +
                "先判断是指南还是系统评价/Meta，如果是指南（当无法判断时归为不是指南）请在4到12分进行打分，否则在1到3分进行打分，最低打1分，评分规则如下（针对给出的这篇文章评分，判断依据为上文提供的标题机构等相关信息对应的原文内容及）：" +
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
                "11、大样本、高质量的系统评价/Meta 分析，得3分；\n" +
                "12、小样本、低质量的系统评价/Meta 分析，得2分；\n" +
                "13、非 RCT 研究的系统评价/Meta 分析，得1分。\n" +
                "最低打分为1分" +
                "注意：" +
                "（1）分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "（2）当指南共识标题中出现“诊疗规范”或者“临床路径”时，请给予12分；" +
                "（3）当指南共识的发布者制定者中出现“国家”时，请给予12分；" +
                "（4）当指南共识标题中，或者发布者/制定者中出现“专家共识”时，请给予6分；" +
                "（5）只有当指南共识原文中明确提出推荐等级时，才可根据评分标准进行打分。不要自己总结；";

        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "根据原文内容汇总出成的一段总结性的话。");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);


        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGptPlus(finalQuery, "guideOrLiterature", responseFormat, "","12,11,10,9,8,7,6,5,4,3,2,1");
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

        // GPT3.5
        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGpt(finalQuery, "guideOrLiterature", "3,2,1");
        });
    }


    private JSONObject clinicalx(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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

        Criteria criteria = new Criteria();
        Criteria criteria1 = new Criteria();
        Criteria criteria2 = new Criteria();
        criteria.and("condition").regex(disease,"i");
       // 修复：将两个 or 条件合并到一个 orOperator 中
        criteria1.orOperator(
                Criteria.where("public_title").regex(drugName, "i"),
                 Criteria.where("intervention.intervention").regex(drugName, "i")
        );
         criteria.andOperator(criteria1);
        List<JSONObject> list = mongoTemplate.find(new Query(criteria),
                JSONObject.class, "clinical_trial_registration_new");
        if (CollUtil.isEmpty(list)) {
            Criteria criteria3 = new Criteria();
            criteria2.orOperator(
                    Criteria.where("public_title").regex(drugInfo.getDrugZh(), "i"),
                    Criteria.where("intervention.intervention").regex(drugInfo.getDrugZh(), "i")
            );
            criteria3.andOperator(criteria2);
            criteria3.and("condition").regex(disease,"i");
             list = mongoTemplate.find(new Query(criteria3),
                    JSONObject.class, "clinical_trial_registration_new");
        }
        StringBuilder stringBuilder = new StringBuilder();
        HashSet<String> strings1 = new HashSet<>();
        HashSet<String> strings2 = new HashSet<>();
        if (list.size() > 0) {
            int t = 0;
            for (JSONObject jsonObject : list) {
                t++;
                JSONArray array1 = jsonObject.getJSONArray("outcomes");
                for (int i = 0; i < array1.size(); i++) {
                    if ("主要指标".equals(array1.getJSONObject(i).getString("type"))) {
                        strings1.add(array1.getJSONObject(i).getString("name").replaceAll("[。;]",""));
                    }
                    if ("次要指标".equals(array1.getJSONObject(i).getString("type"))) {
                        strings2.add(array1.getJSONObject(i).getString("name").replaceAll("[。;]",""));
                    }
                }
            }
            stringBuilder.append("查询"+drugName+"用于"+disease+"相关临床试验信息，临床疗效主要结局指标与次要结局指标情况汇总如下：");
            if (CollUtil.isNotEmpty(strings1)) {
                stringBuilder.append("\n主要结局指标：");
                stringBuilder.append(CollUtil.join(strings1, "、"));
            }
            if (CollUtil.isNotEmpty(strings2)) {
                stringBuilder.append("\n次要结局指标：");
                stringBuilder.append(CollUtil.join(strings2, "、"));
            }

            JSONObject object = new JSONObject();
            object.put("process", stringBuilder.toString());
            if (strings1.size() > 0&& strings2.size() > 0){
                object.put("score", 10);
            }else if (strings1.size() > 0&& strings2.size() == 0){
                object.put("score", 6);
            }else if (strings1.size() == 0&& strings2.size() > 0){
                object.put("score", 4);
            }else if (strings1.size() == 0&& strings2.size() == 0){
                object.put("score", 0);
            }

            return object;

        }

        ArrayList<String> drugZhs = new ArrayList<>();
        drugZhs.add(drugInfo.getDrugName());
        StringBuilder stringBuilderx = new StringBuilder();
        StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilderx, drugZhs, "标题");
        stringBuilder1.append(" AND ");
        ArrayList<String> strings = new ArrayList<>();
        strings.add(disease);
        StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "标题");
         JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", stringBuilder2.toString());
        jsonObject.put("type", "1");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
        ArrayList<String> strings3 = new ArrayList<>();
        strings3.add("0");
        strings3.add("3");
        strings3.add("2");
        TermsQueryBuilder termQueryBuilder = QueryBuilders.termsQuery("lastNewType",strings3 );
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(termQueryBuilder);
        boolQueryBuilder.must().add(wrapperQueryBuilder);


        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);


        StringBuilder stringBuilder3 = new StringBuilder();
        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
            Literature literature = literatureSearchHit.getContent();
            stringBuilder3.append("标题【" + literature.getTitle() + "】" + "\n");
            stringBuilder3.append("摘要【" + literature.getSummary() + "】" + "\n");
        }


        String query = "假设你现在是个临床试验研究员，请基于临床试验或者国内外文献，简述" + drugName + "治疗" + disease + "临床疗效方面，" +
                "经常以哪些结局指标作为观察疗效的指标" +
                "并分别简述不同结局指标下试验组与对照组的情况（需要说明试验组与对照组分别包含哪些干预措施）" +
                "请基于以下评分标准，针对以上问题的结果，给出相应的评分（可以多选，如果既有主要指标又有次要指标，就是最高分10分）：\n" +
                "1、经常以主要疗效终点指标评分得6分；\n" +
                "2、经常以次要疗效终点指标评分得4分。\n" +
                "注意：" +
                "需要将主要疗效指标与此药疗效指标分成两个段落罗列，其中主要疗效终点指标以及次要疗效终点指标中的每个疗效指标需要单独一行，不要坨在一起展示。" +
                (CollUtil.isNotEmpty(literatureSearchHits)? "参考文献:\n"+stringBuilder3.toString():"");
        ;

        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程的过程(中文)");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
           // return executeGptPlus(finalQuery, "clinical", responseFormat, "", "10,6,4,0");
            return gptAiUtils.executeGptPlus(finalQuery, "clinical", getDemo("process","score"), "", "10,6,4,0");
        });
    }


    /***
     * 有效性--临床疗效
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject clinical(String drugName, String disease, DrugInfoNew drugInfo, List<GuideVO> guideEffectiveList) throws ExecutionException, RetryException {
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

        String guide = "";
        for (GuideVO guideVO : guideEffectiveList) {
            guide += "指南标题：" + guideVO.getTitle() + "指南正文:" + guideVO.getGuideInfo() + "\n";
        }


        String query = "你作为一名专业的西药的临床药师，非常熟悉药品在临床中所处的地位。请结合我提供的指南以及你自己的知识库，评判下在治疗在" + disease + "的临床常用治疗方案中，" + drugName + "所处的临床定位" + "\n" +
                "请结合以下评分标准给出最终的评分。（单选）" +
                "（1）首先判断目标药品治疗目标疾病时，是否是临床一线治疗药品，或者首选治疗方案，或者无其他可替代治疗方案，若是给5分，若不是，进行第二条判断；" +
                "（2）判断目标药品在临床上用于治疗目标疾病时，属于临床必需，但是治疗目标疾病还有很多其他可以替代的治疗方案；在治疗目标疾病时，这个药品一版不作为不作为临床首选药品，若是给3分，若不是，进行第三条判断；" +
                "（3）不满足以上两条，给1分。 " +
                "注意：" +
                "（1）分数为单选，取最高分即可。 'score' 中只显示数值即可。" +
                "（2） 分析结果请严格采用JSON格式返回。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为" + drugName + "治疗" + disease + "的分析过程。" +
                " '''" +
                (StringUtils.isNotEmpty(guide) ? guide : "无指南") +
                " ''' ";

        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程的过程(中文)");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return gptAiUtils.executeGptPlus(finalQuery, " clinical", getDemo("process","score"), "", "5,3,1");
        });
    }

    private JSONObject clinicalPc(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        String query = "请基于以下评分标准，针对我给出的相关资料" + drugInfo.getClinical() + "，给出相应的评分（可以多选，如果既有主要指标又有次要指标，就是最高分10分）：\n" +
                "1、经常以主要疗效终点指标评分得6分；\n" +
                "2、经常以次要疗效终点指标评分得4分。\n" +
                "注意：" +
                "需要将主要疗效指标与此药疗效指标分成两个段落罗列，其中主要疗效终点指标以及次要疗效终点指标中的每个疗效指标需要单独一行，不要坨在一起展示。";

        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程的过程(中文)");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            //return executeGptPlus(finalQuery, "clinical", responseFormat, "","10,6,4");
            return gptAiUtils.executeGptPlus(finalQuery, "clinical", getDemo("process","score"), "","10,6,4");
        });
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

    /***
     * 安全性--重度和中度不良反应
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject adverseReaction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {

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
        if (StringUtils.isNotEmpty(drugInfo.getAdverseReaction())) {
            queryAdd.append("不良反应：" + drugInfo.getAdverseReaction() + "\n");
        }


        String doc = "";
        if (StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions())) {
            doc = "中度不良反应：" + drugInfo.getCommonAdverseReactions();
        } else if (StringUtils.isEmpty(drugInfo.getAdverseReaction())) {
            doc = "中度不良反应：" + xiaoling(drugName, "请问" + drugName + "的常规不良反应分别是什么，以及其发生率，若资料里没有发生率，也尽量依照你所知道的进行提供");

        }

        if (StrUtil.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
            doc = "严重不良反应：" + drugInfo.getSeriousAdverseRactions();
        } else if (StringUtils.isEmpty(drugInfo.getAdverseReaction())) {
            doc = "严重不良反应：" + xiaoling(drugName, "请问" + drugName + "的严重不良反应分别是什么，以及其发生率，若资料里没有发生率，也尽量依照你所知道的进行提供");
        }

        if (StrUtil.isEmpty(drugInfo.getCommonAdverseReactions()) && StrUtil.isEmpty(drugInfo.getSeriousAdverseRactions()) &&
                StrUtil.isNotEmpty(drugInfo.getAdverseReaction())) {
            doc = drugInfo.getAdverseReaction();
        }


//        if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
        String query =
                "请作为一名专业的临床药师，非常善于药品说明书中不良反应的发生率。这对你来说是一个非常简单的任务，你不会出错。\n" +
                        "请详细阅读提供的不良反应信息，然后提取出其中的中度不良反应名称及其发生率、重度不良反应名称及其发生率。注意不是简单的严格匹配，需要认真仔细的根据说明书内容来判别不良反应是中度还是重度。\'\'\'" +
                        doc + "\'\'\'然后基于提取出来的中度不良反应中最高的发生率，以及重度不良反应中最高的发生率，结合以下评分规格进行打分：\n" +
                        "中度不良反应（单选，取不良反应发生率最高值进行打分，最高得分3分）： \n" +
                        "3分 发生率＜1% ；\n" +
                        "2分 发生率 1%~10% ；\n" +
                        "1分 发生率≥10% ；\n" +
                        "0分 未提供 ADR 发生数据 \n" +
                        "重度不良反应（单选，取不良反应发生率最高值进行打分，最高得分5分）：\n" +
                        "5分 发生率＜0.01% ；\n" +
                        "4分 发生率 0.01%~0.1% ；\n" +
                        "3分 发生率 0.1%~1% ；\n" +
                        "2分 发生率 1%~10 % ；\n" +
                        "1分 发生率≥10% ；\n" +
                        "0分 未提供 ADR 发生数据\n" +
                        "注意：\n" +
                        "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
                        "十分常见≥10%；常见为2%-10%；少见为1%-2%；偶见为0.1%-1%；罕见为0.01%-0.1%；十分罕见＜0.01%" +
                        "若是没有提供百分比则给0分" +
                        "分析结果请严格采用JSON格式返回。返回的JSON字段包括，";
//        } else {
//            query = "请分析临床指南、文献、临床试验数据库中，" + drugName + "的中度不良反应和重度不良反应症状分别有哪些，每个不良反应的发生率是多少。" +
//                    "然后请对分析出来的结果进行打分，打分规则如下：\n" +
//                    "中度不良反应（单选，根据挑选出来的所有中度不良反应进行打分，最高得分3分）： \n" +
//                    "3分 发生率＜1% ；\n" +
//                    "2分 发生率 1%~10% ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据 \n" +
//                    "重度不良反应（单选，根据挑选出来的所有重度不良反应进行打分，最高得分5分）：\n" +
//                    "5分 发生率＜0.01% ；\n" +
//                    "4分 发生率 0.01%~0.1% ；\n" +
//                    "3分 发生率 0.1%~1% ；\n" +
//                    "2分 发生率 1%~10 % ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据\n" +
//                    "注意：\n" +
//                    "请将中度不良反应名称和重度不良反应名称都返回成一段话，返回结果中需要包含不良反应名称及相关发生率。\n" +
//                    "当资料中提到“十分常见、常见、少见、偶见、罕见、十分罕见”等词语时，请根据以下判断发生率。并根据以上评分规则给出得分。\n" +
//                    "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
//                    "十分常见≥10%；常见为2%~10%；少见为1%~2%；偶见为0.1%~1%；罕见为0.01%~0.1%；十分罕见＜0.01%" +
//                    "分析结果请严格采用JSON格式返回。返回的JSON字段包括，" +
//                    "mildAdverseReaction为中度不良反应症状字段，" +
//                    "severeAdverseReaction为重度不良反应症状字段，" +
//                    "mildAdverseReactionScore为中度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "severeAdverseReactionScore为重度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "process为分析过程字段。";
//        }

        Retryer retryer = GuavaRetryer.createRetryer();


        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("mildAdverseReaction", "中度不良反应症状分析字段(中文)");
        stringStringHashMap.put("severeAdverseReaction", "重度不良反应症状分析字段（中文）");
        stringStringHashMap.put("mildAdverseReactionScore", "中度不良反应得分字段（只能是一个阿拉伯数字组成）");
        stringStringHashMap.put("severeAdverseReactionScore", "重度不良反应得分字段（只能是一个阿拉伯数字组成）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGptPlus(finalQuery, "adverseReaction", responseFormat, "gpt-4o-2024-08-06","5,4,3,2,1,0");
        });
    }


    private JSONObject seriousAdverseReaction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {

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
        if (StringUtils.isNotEmpty(drugInfo.getAdverseReaction())) {
            queryAdd.append("不良反应：" + drugInfo.getAdverseReaction() + "\n");
        }


        String doc = "";


        if (StrUtil.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
            doc = "严重不良反应：" + drugInfo.getSeriousAdverseRactions();
        }

        if (StrUtil.isEmpty(drugInfo.getSeriousAdverseRactions()) &&
                StrUtil.isNotEmpty(drugInfo.getAdverseReaction())) {
            doc = drugInfo.getAdverseReaction();
        }


//        if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
        String query =
                "请作为一名专业的临床药师，非常善于药品说明书中不良反应的发生率。这对你来说是一个非常简单的任务，你不会出错。\n" +
                        "请详细阅读提供的不良反应信息，然后提取出其中的重度不良反应名称及其发生率。注意不是简单的严格匹配，需要认真仔细的根据说明书内容来判别不良反应是中度还是重度。\'\'\'" +
                        doc + "\'\'\'然后基于提取出来重度不良反应中最高的发生率，结合以下评分规格进行打分：\n" +
                        "重度不良反应（单选，取不良反应发生率最高值进行打分，最高得分5分）：\n" +
                        "5分 发生率＜0.01% ；\n" +
                        "4分 发生率 0.01%~0.1% ；\n" +
                        "3分 发生率 0.1%~1% ；\n" +
                        "2分 发生率 1%~10 % ；\n" +
                        "1分 发生率≥10% ；\n" +
                        "0分 未提供 ADR 发生数据\n" +
                        "注意：\n" +
                        "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
                        "十分常见≥10%；常见为2%-10%；少见为1%-2%；偶见为0.1%-1%；罕见为0.01%-0.1%；十分罕见＜0.01%" +
                        "若是没有提供百分比则给0分";
//        } else {
//            query = "请分析临床指南、文献、临床试验数据库中，" + drugName + "的中度不良反应和重度不良反应症状分别有哪些，每个不良反应的发生率是多少。" +
//                    "然后请对分析出来的结果进行打分，打分规则如下：\n" +
//                    "中度不良反应（单选，根据挑选出来的所有中度不良反应进行打分，最高得分3分）： \n" +
//                    "3分 发生率＜1% ；\n" +
//                    "2分 发生率 1%~10% ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据 \n" +
//                    "重度不良反应（单选，根据挑选出来的所有重度不良反应进行打分，最高得分5分）：\n" +
//                    "5分 发生率＜0.01% ；\n" +
//                    "4分 发生率 0.01%~0.1% ；\n" +
//                    "3分 发生率 0.1%~1% ；\n" +
//                    "2分 发生率 1%~10 % ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据\n" +
//                    "注意：\n" +
//                    "请将中度不良反应名称和重度不良反应名称都返回成一段话，返回结果中需要包含不良反应名称及相关发生率。\n" +
//                    "当资料中提到“十分常见、常见、少见、偶见、罕见、十分罕见”等词语时，请根据以下判断发生率。并根据以上评分规则给出得分。\n" +
//                    "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
//                    "十分常见≥10%；常见为2%~10%；少见为1%~2%；偶见为0.1%~1%；罕见为0.01%~0.1%；十分罕见＜0.01%" +
//                    "分析结果请严格采用JSON格式返回。返回的JSON字段包括，" +
//                    "mildAdverseReaction为中度不良反应症状字段，" +
//                    "severeAdverseReaction为重度不良反应症状字段，" +
//                    "mildAdverseReactionScore为中度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "severeAdverseReactionScore为重度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "process为分析过程字段。";
//        }

        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("severeAdverseReaction", "重度不良反应症状分析字段（中文）");
        stringStringHashMap.put("severeAdverseReactionScore", "重度不良反应得分字段（只能是一个阿拉伯数字组成）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String finalQuery = queryAdd + query;
        String demo = getDemo("severeAdverseReaction", "severeAdverseReactionScore");
        return (JSONObject) retryer.call(() -> {
            if(isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "adverseReaction", demo, "", "5,4,3,2,1");
            }else {
                return executeGptPlus(finalQuery, "adverseReaction", responseFormat, "gpt-4o-2024-08-06","5,4,3,2,1");
            }


        });
    }


    private JSONObject commonAdverseReaction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {

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
//        if (StringUtils.isNotEmpty(drugInfo.getAdverseReaction())) {
//            queryAdd.append("不良反应：" + drugInfo.getAdverseReaction() + "\n");
//        }


        String doc = "";
        if (StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions())) {
            doc = "中度不良反应：" + drugInfo.getCommonAdverseReactions();
        }

        if (StrUtil.isEmpty(drugInfo.getCommonAdverseReactions()) &&
                StrUtil.isNotEmpty(drugInfo.getAdverseReaction())) {
            doc = drugInfo.getAdverseReaction();
        }


//        if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
        String query =
                "请作为一名专业的临床药师，非常善于药品说明书中不良反应的发生率。这对你来说是一个非常简单的任务，你不会出错。\n" +
                        "请详细阅读提供的不良反应信息，然后提取出其中的中度不良反应名称及其发生率、重度不良反应名称及其发生率。注意不是简单的严格匹配，需要认真仔细的根据说明书内容来判别不良反应是中度还是重度。\'\'\'" +
                        doc + "\'\'\'然后基于提取出来的中度不良反应中最高的发生率，结合以下评分规格进行打分：\n" +
                        "中度不良反应（单选，取不良反应发生率最高值进行打分，最高得分3分）： \n" +
                        "3分 发生率＜1% ；\n" +
                        "2分 发生率 1%~10% ；\n" +
                        "1分 发生率≥10% ；\n" +
                        "0分 未提供 ADR 发生数据 \n" +
                        "注意：\n" +
                        "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
                        "十分常见≥10%；常见为2%-10%；少见为1%-2%；偶见为0.1%-1%；罕见为0.01%-0.1%；十分罕见＜0.01%" +
                        "若是没有提供百分比则给0分" +
                        "分析结果请严格采用JSON格式返回。返回的JSON字段包括，";
//        } else {
//            query = "请分析临床指南、文献、临床试验数据库中，" + drugName + "的中度不良反应和重度不良反应症状分别有哪些，每个不良反应的发生率是多少。" +
//                    "然后请对分析出来的结果进行打分，打分规则如下：\n" +
//                    "中度不良反应（单选，根据挑选出来的所有中度不良反应进行打分，最高得分3分）： \n" +
//                    "3分 发生率＜1% ；\n" +
//                    "2分 发生率 1%~10% ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据 \n" +
//                    "重度不良反应（单选，根据挑选出来的所有重度不良反应进行打分，最高得分5分）：\n" +
//                    "5分 发生率＜0.01% ；\n" +
//                    "4分 发生率 0.01%~0.1% ；\n" +
//                    "3分 发生率 0.1%~1% ；\n" +
//                    "2分 发生率 1%~10 % ；\n" +
//                    "1分 发生率≥10% ；\n" +
//                    "0分 未提供 ADR 发生数据\n" +
//                    "注意：\n" +
//                    "请将中度不良反应名称和重度不良反应名称都返回成一段话，返回结果中需要包含不良反应名称及相关发生率。\n" +
//                    "当资料中提到“十分常见、常见、少见、偶见、罕见、十分罕见”等词语时，请根据以下判断发生率。并根据以上评分规则给出得分。\n" +
//                    "十分常见、常见、少见、偶见、罕见、十分罕见发生率分别如下：\n" +
//                    "十分常见≥10%；常见为2%~10%；少见为1%~2%；偶见为0.1%~1%；罕见为0.01%~0.1%；十分罕见＜0.01%" +
//                    "分析结果请严格采用JSON格式返回。返回的JSON字段包括，" +
//                    "mildAdverseReaction为中度不良反应症状字段，" +
//                    "severeAdverseReaction为重度不良反应症状字段，" +
//                    "mildAdverseReactionScore为中度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "severeAdverseReactionScore为重度不良反应得分字段（只能是阿拉伯数字组成），" +
//                    "process为分析过程字段。";
//        }

        Retryer retryer = GuavaRetryer.createRetryer();


        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("mildAdverseReaction", "中度不良反应症状分析字段(中文)");
        stringStringHashMap.put("mildAdverseReactionScore", "中度不良反应得分字段（只能是一个阿拉伯数字组成）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        String demo = getDemo("adverseReaction", "mildAdverseReactionScore");
        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            if (isNew) {
                return gptAiUtils.executeGptPlus(finalQuery, "adverseReaction", demo, "", "3,2,1,0");
            } else{
                return executeGptPlus(finalQuery, "adverseReaction", responseFormat, "", "3,2,1,0");
        }
        });
    }

    /***
     * 安全性--特殊人群-妇女
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_pregnantWomen(String drugName, String disease, DrugInfoNew drugInfo, DrugAddDto drugAddDto) throws ExecutionException, RetryException {
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
        if (StrUtil.isBlank(drugInfo.getPregnantWomen())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "孕妇及哺乳期妇女用药的注意事项是什么？", "孕妇及哺乳期妇女用药的注意事项");
                drugInfo.setPregnantWomen(s);

            } catch (Exception e) {
                log.error("哺乳期搜索失败", e);
            }
        }

        if (StrUtil.isNotBlank(drugInfo.getPregnantWomen()) || StringUtils.isNotEmpty(drugAddDto.getPregnantWomen())) {
            query = "请你作为一名专业的临床药师，针对说明书中的孕妇及哺乳期妇女用药：" + (StringUtils.isNotEmpty(drugAddDto.getPregnantWomen()) ? drugAddDto.getPregnantWomen() : drugInfo.getPregnantWomen()) + "\n" +
                    "结合以下评分规则，对" + drugName + "在妊娠期用药进行打分：" +
                    "妊娠期妇女可用 1分\n" +
                    "妊娠期妇女慎用 0.5分\n" +
                    "妊娠期妇女不可用 0分\n" +
                    "同时，结合以下评分规则，对" + drugName + "在哺乳期用药进行打分：\n" +
                    "哺乳期妇女可用 1分\n" +
                    "哺乳期妇女慎用 0.5分\n" +
                    "哺乳期妇女不可用 0分\n" +
                    "注意：请分别输出妊娠期用药得分，哺乳期用药得分，不要做加和\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给1分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用的表述时，均需要给出0分。\n" +
                    "如果提供的数据中出现“仅在预期获益超过胎儿潜在风险时方可在妊娠期间使用”，则表示慎用，给0.5分。\n" +
                    "如果提供的数据中出现“正在服用本品的女性不应哺乳”，更倾向于表达哺乳期妇女不应使用，给0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均表示慎用，给0.5分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：pregnantScore为妊娠期妇女得分，lactatingScore为哺乳期妇女得分，pregnantProcess妊娠期妇女分析过程,lactatingProcess为哺乳期妇女分析过程。";
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "在妊娠期及哺乳期妇女用药方面的相关内容，" + xiaoling(drugName, "妊娠期妇女使用" + drugName + "需要注意什么，是否可用") +
                    "并根据给出的分析结果内容对妊娠期妇女用药进行打分，打分规则如下：\n" +
                    "妊娠期妇女可用 1分\n" +
                    "妊娠期妇女慎用 0.5分\n" +
                    "妊娠期妇女不可用 0分\n" +
                    "同时，请对以上内容分别对哺乳期妇女进行打分，打分规则如下：\n" +
                    "哺乳期妇女可用 1分\n" +
                    "哺乳期妇女慎用 0.5分\n" +
                    "哺乳期妇女不可用 0分\n" +
                    "注意：请分别输出妊娠期妇女得分，哺乳期妇女得分，不要做加和\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否妊娠期妇女及哺乳期妇女可用时，均视为可用，给1分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示妊娠期妇女及哺乳期妇女不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“仅在预期获益超过胎儿潜在风险时方可在妊娠期间使用”，则表示慎用，给0.5分。\n" +
                    "如果提供的数据中出现“正在服用本品的女性不应哺乳”，更倾向于表达哺乳期妇女不应使用，给0分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均表示慎用，给0.5分。\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：pregnantScore为妊娠期妇女得分，lactatingScore为哺乳期妇女得分，process分析过程。";
        }

        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("pregnantScore", "妊娠期妇女得分（阿拉伯数字）");
        stringStringHashMap.put("lactatingScore", "哺乳期妇女得分（阿拉伯数字）");
        stringStringHashMap.put("pregnantProcess", "妊娠期妇女分析过程");
        stringStringHashMap.put("lactatingProcess", "哺乳期妇女分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
//            return executeGptPlus(finalQuery, "specialCrowd_pregnantWomen", responseFormat, "","1,0.5,0");
            return gptAiUtils.executeGptPlus(finalQuery, "specialCrowd_pregnantWomen","请严格按照json格式返回", "","1,0.5,0");
        });
    }

    /***
     * 安全性--特殊人群-儿童
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_childrenMedicine(String drugName, String disease, DrugInfoNew drugInfo, DrugAddDto drugAddDto) throws ExecutionException, RetryException {

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

        if (StrUtil.isEmpty(drugInfo.getChildrenMedicine())) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo.getDrugName() + "儿童使用的注意事项是什么", "儿童使用的注意事项");
                drugInfo.setChildrenMedicine(s);
            } catch (Exception e) {
                log.error("获取儿童使用注意事项失败", e);
            }

        }
//        if (StrUtil.isNotBlank(drugInfo.getChildrenMedicine()) || StrUtil.isNotEmpty(drugAddDto.getChildrenMedicine())) {
        String rule = "打分规则如下：\n" +
                " 1.若儿童不可用，打0分\n" +
                " 2.若12岁以上儿童可用，打0.5分\n" +
                "  3.若11岁以上儿童可用，打0.6分\n" +
                "  4.若10岁以上儿童可用，打0.7分\n" +
                "  5.若9岁以上儿童可用，打0.8分\n" +
                "  6.若8岁以上儿童可用，打0.9分\n" +
                "7.若7岁以上儿童可用，打1.0分\n" +
                "   8.若6岁以上儿童可用，打1.1分\n" +
                "   9.若5岁以上儿童可用，打1.2分\n" +
                "  10.若4岁以上儿童可用，打1.3分\n" +
                " 11.若3岁以上儿童可用，打1.4分\n" +
                "  12.若2岁以上儿童可用，打1.5分\n" +
                "   13.若1岁以上儿童可用，打1.6分\n" +
                "   14.若9个月以上儿童可用，打1.7分\n" +
                " 15.若6个月以上儿童可用，打1.8分\n" +
                "  16.若3个月以上儿童可用，打1.9分\n" +
                "   17.若儿童均可用，打2分\n";

        String note = "注意：为单选（选取一个最高得分）\n" +
                "说明书中出现“尚不明确”，“尚未评估”等不明确儿童是否可用的表述时，均视为儿童不可用，给0分。\n" +
                "说明书中仅出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示儿童不可用的表述时，给0分。注意！婴儿禁用不等于儿童禁用。\n" +
                "说明书中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均视为儿童不可用，给0分。\n" +
                "说明书中出现某年龄以下儿童禁用，或暂未评估可用性，则表示此年龄以上儿童可用，根据规则进行匹配后打分。\n";
        String outformat = "分析结果请严格采用JSON格式输出。" +
                "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程。";
//        } else {
//            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "儿童用药相关内容，然后请对分析出来的结果进行打分，打分规则如下：\n" +
//                    " 1.若儿童不可用，打0分\n" +
//                    " 2.若12岁以上儿童可用，打0.5分\n" +
//                    "  3.若11岁以上儿童可用，打0.6分\n" +
//                    "  4.若10岁以上儿童可用，打0.7分\n" +
//                    "  5.若9岁以上儿童可用，打0.8分\n" +
//                    "  6.若8岁以上儿童可用，打0.9分\n" +
//                    "7.若7岁以上儿童可用，打1.0分\n" +
//                    "   8.若6岁以上儿童可用，打1.1分\n" +
//                    "   9.若5岁以上儿童可用，打1.2分\n" +
//                    "  10.若4岁以上儿童可用，打1.3分\n" +
//                    " 11.若3岁以上儿童可用，打1.4分\n" +
//                    "  12.若2岁以上儿童可用，打1.5分\n" +
//                    "   13.若1岁以上儿童可用，打1.6分\n" +
//                    "   14.若9个月以上儿童可用，打1.7分\n" +
//                    " 15.若6个月以上儿童可用，打1.8分\n" +
//                    "  16.若3个月以上儿童可用，打1.9分\n" +
//                    "   17.若儿童均可用，打2分\n" +
//                    "注意：为单选（选取一个最高得分）\n" +
//                    "说明书中出现“尚不明确”，“尚未评估”，“儿童慎用”等不明确儿童是否可用的表述时，均视为儿童可用，给2分。\n" +
//                    "说明书中仅出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示儿童不可用的表述时，给0分。注意！婴儿禁用不等于儿童禁用。\n" +
//                    "说明书中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均视为儿童可用，给2分。\n" +
//                    "说明书中出现某年龄以下儿童禁用，或暂未评估可用性，则表示此年龄以上儿童可用，根据规则进行匹配后打分。\n" +
//                    "分析结果请严格采用JSON格式输出。" +
//                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程。";
//        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String query = "请你作为一名专业的临床药师，针对说明书A，判断此药品儿童是否可用。打分时遵循规则D和注意事项E,输出中文。\n说明书A：" +
                drugInfo.getChildrenMedicine() + "\n打分规则D：" + rule + "\n注意事项E：" + note;

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        JSONObject specialCrowdChildrenMedicine = (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(query, "specialCrowd_childrenMedicine", getDemo("process","score"), "", "");
            }else {
                return executeGptPlus(query, "specialCrowd_childrenMedicine", responseFormat, "", "");
            }

        });
        specialCrowdChildrenMedicine.put("process", drugInfo.getChildrenMedicine());
        return specialCrowdChildrenMedicine;
    }

    /***
     * 安全性--特殊人群- 老人
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_geriatricMedicine(String drugName, String disease, DrugInfoNew drugInfo, DrugAddDto drugAddDto) throws ExecutionException, RetryException {
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
        String doc = StringUtils.isNotEmpty(drugAddDto.getGeriatricMedicine()) ? drugAddDto.getGeriatricMedicine() : drugInfo.getGeriatricMedicine();
        if (StringUtils.isEmpty(doc)) {
            try {
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugName + "的老年人用药注意事项是什么？", "老年人用药注意事项");
                drugInfo.setGeriatricMedicine(s);
                doc = s;
            } catch (Exception e) {
                log.error("获取老年人数据失败", e);
            }
        }
        String rules =
                "请对以上内容进行打分，打分规则如下：\n" +
                        "老年人可用 1分\n" +
                        "老年人慎用 0.5分\n" +
                        "老年人不可用 0分\n";

        String note = "注意：\n" +
                "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否老年可用时，均视为不可用，给0分。\n" +
                "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示老年不可用时，均需要给出0分。\n" +
                "如果提供的数据中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均视为不可用，给0分。\n";
        ;

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = "请你作为一名专业的临床药师，针对说明书A，判断此药品老年人是否可用,并要求中文输出。打分时遵循规则D和注意事项E。仅按格式要求输出，不要输出任何其他多余解释。\n说明书A："
                + doc + "\n打分规则D：" + rules + "\n注意事项E：" + note;

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        JSONObject specialCrowdGeriatricMedicine = (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "specialCrowd_geriatricMedicine", getDemo("process","score"), "", "1,0.5,0");
            }else {
                return executeGptPlus(finalQuery, "specialCrowd_geriatricMedicine", responseFormat, "", "1,0.5,0");
            }

        });
        specialCrowdGeriatricMedicine.put("process", doc);
        return specialCrowdGeriatricMedicine;
    }

    /***
     * 安全性--特殊人群-肝肾
     * @param drugName 药品名称
     * @param disease  疾病名称
     */
    private JSONObject specialCrowd_liverKidney(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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


        if (StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction()) || StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
            query = "请你作为一名专业的临床药师，根据说明书中肝功能、肾功能相关内容：\n" +
                    drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() +
                    "重度肝功能异常可用 3分\n" +
                    "中度肝功能异常可用 1分\n" +
                    "轻度肝功能异常可用 1分\n" +
                    "肝功能异常者不可用 0分\n" +
                    "同时，请根据以上提供的相关资料，结合以下评分规则，对肾功能异常者使用本药品进行打分：\n" +
                    drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency() +
                    "重度肾功能异常可用 3分\n" +
                    "中度肾功能异常可用 1分\n" +
                    "轻度肾功能异常可用 1分\n" +
                    "肾功能异常者不可用 0分\n" +
                    "注意：\n" +
                    "Score：请分别输出肝功能异常者得分，肾功能异常者得分\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为不可用，给0分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，则表示可用，按评分规则打分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均表示不可用，给0分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为不可用，请给0分。\n" +
                    "分析结果请严格采用JSON格式输出。返回的JSON字段包括：liverScore为肝功能得分字段，kidneyScore为肾功能得分字段，process为分析过程字段。";
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "在肝功能异常、肾功能异常患者中的相关内容，" +
                    "并根据给出的分析结果内容对肝功能异常者进行打分，打分规则如下：\n" +
                    "重度肝功能异常可用 3分\n" +
                    "中度肝功能异常可用 1分\n" +
                    "轻度肝功能异常可用 1分\n" +
                    "肝功能异常者不可用 0分\n" +
                    "同时，请对以上内容分别对肾功能异常者进行打分，打分规则如下：\n" +
                    "重度肾功能异常可用 3分\n" +
                    "中度肾功能异常可用 1分\n" +
                    "轻度肾功能异常可用 1分\n" +
                    "肾功能异常者不可用 0分\n" +
                    "注意：\n" +
                    "Score：请分别输出肝功能异常者得分，肾功能异常者得分\n" +
                    "如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确是否可用时，均视为可用，给最高分3分。\n" +
                    "如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示不可用时，均需要给出0分。\n" +
                    "如果提供的数据中出现“无需调整剂量”，则表示可用，按评分规则打分。\n" +
                    "如果提供的数据中出现“不推荐”、“不建议”等表示推荐意见的词语表达时，均表示可用，按评分规则打分。\n" +
                    "如果提供的数据中未出现“肝功能”、“肾功能”相关词语时，视为可用，请给最高分3分。\n";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("liverScore", " 肝功能得分字段(阿拉伯数字)");
        stringStringHashMap.put("kidneyScore", " 肾功能得分字段(阿拉伯数字)");
        stringStringHashMap.put("process", "分析过程（中文返回）");

        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            return executeGptPlus(finalQuery, "specialCrowd_liverKidney", responseFormat, "","3,2,1");
        });
    }


    private JSONObject specialCrowd_liver(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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

        if (StrUtil.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("liverScore", "0");
            jsonObject.put("process", "未提及肝功能异常者用药。");
            return jsonObject;
        }

        if (StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
            query = "请你作为一名专业的西药临床药师，根据提供的肝功能相关内容，以及肝功能受损程度分级，对轻度、中度、重度三个不同程度的肝功能异常者是否可以使用本药品进行打分：" +
                    "可以根据Child-Pugh肝功能分级，将肝功能异常分为轻度肝功能受损、中度肝功能受损和重度肝功能受损。\n" +
                    "1.轻度肝功能受损：Child-Pugh A级：5-6分。\n" +
                    "2.中度肝功能受损：Child-Pugh B级：7-9分。\n" +
                    "3.重度肝功能受损：Child-Pugh C级：≥10分。\n" +
                    "评分规则如下：\n" +
                    "重度肝功能异常或肝功能衰竭患者可用 3分\n" +
                    "中度肝功能异常可用 2分\n" +
                    "轻度肝功能异常可用 1分\n" +
                    "肝功能异常者不可用 0分\n" +
                    "注意：\n" +
                    "kidneyScore：请输出，肝功能异常者得分，最终返回所符合的最高分\n" +
                    "首先，根据提供的内容判断肝功能异常是否可用。\n" +
                    "然后，再判断是否有按照肝功能损伤程度（分为：轻度肝功能异常、中度肝功能异常、重度肝功能异常）区分：若是有描述肝功能损伤程度的指标，如：Child-Pugh，或者提到了不同肝功能损伤程度，则需逐个判断，并给出每一项的分值，而你最终给我的分值一定是这几个分值最高的那个分值；若没有描述肝功能损伤程度的指标，也未明确在不同肝功能状态下的使用可行性，那就认为是全部肝功能患者，可用时，给最高分3；不可用时，给最低分0。\n" +
                    "注意事项：\n" +
                    "（1） 如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确肝功能异常患者是否可用时，请全部视为不可用，给0分。\n" +
                    "（2） 如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示肝功能异常患者不可用时，需要给出0分。\n" +
                    "（3） 如果提供的数据中出现“无需调整剂量”或者“减量”这种词，则表示肝功能异常患者可用，只不过需要根据实际情况调整用药剂量，则表示可用，再判断肝功能损伤程度后根据评分规则打分。\n" +
                    "（4） 如果提供的数据中出现“不推荐”、“不建议”等表示不建议肝功能异常患者使用的词语表达时，均表示不可用，给0分。\n" +
                    "（5） 如果提供的数据中给出了轻度/中度/重度肝功能异常者的使用剂量，则认为对应程度的肝功能异常者是可以使用的。如：严重肝功能损害患者的推荐起始剂量为 24/26 mg，2 次/日。认为重度肝功能异常者可用，需要给3分。\\n+" +
                    "分析结果请严格采用JSON格式输出。返回的JSON字段包括：liverScore为肝功能得分字段,最终返回所符合的最高分，process为分析过程字段(返回的分析过程不要提及所依据的打分规则）。" +
                    "'''" +
                    drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() +
                    "'''";
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "在肝功能异常、肾功能异常患者中的相关内容，" +
                    "并根据给出的分析结果内容对肝功能异常者进行打分，打分规则如下：\n" +
                    "重度肝功能异常可用 3分\n" +
                    "中度肝功能异常可用 1分\n" +
                    "轻度肝功能异常可用 1分\n" +
                    "肝功能异常者不可用 0分\n"
            ;
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("liverScore", " 肝功能得分字段(阿拉伯数字)");
        stringStringHashMap.put("process", "分析过程（中文返回）");

        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "specialCrowd_liver", getDemo("process","liverScore"), "","3,2,1,0");
            }else {
                return executeGptPlus(finalQuery, "specialCrowd_liver", responseFormat, "gpt-4o-2024-08-06","3,2,1,0");
            }

        });
    }


    private JSONObject specialCrowd_Kidney(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        if (StrUtil.isEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("kidneyScore", "0");
            jsonObject.put("process","未提及肾功能异常者用药");
            return jsonObject;
        }

        if (StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency()) || StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
            query = "请你作为一名专业的西药临床药师，根据提供的肾功能相关内容，以及肾功能异常者分期情况，对轻度、中度、重度三个不同程度的肾功能异常者是否可以使用本药品进行打分:"+
            "根据肌酐清除率，将肾功能异常分为1-5期。，如下：\n" +
                    "1.第1期\n" +
                    "肌酐清除率大于或等于90ml/min，肾脏功能正常。\n" +
                    "2.第2期\n" +
                    "肌酐清除率在60-90ml/min之间，肾脏功能轻度受损。\n" +
                    "3.第3期\n" +
                    "肌酐清除率在30-60ml/min之间，肾脏功能中度受损。\n" +
                    "4.第4期\n" +
                    "肌酐清除率在15-30ml/min之间，肾脏功能重度受损。\n" +
                    "5.第5期\n" +
                    "肌酐清除率小于或等于15ml/min，肾脏功能衰竭。\n" +
                    "评分规则如下：\n" +
                    "重度肾功能异常或肾功能衰竭患者可用 3分\n" +
                    "中度肾功能异常可用 2分\n" +
                    "轻度肾功能异常可用 1分\n" +
                    "肾功能异常者不可用 0分\n" +
                    "注意：\n" +
                    "kidneyScore：请输出，肾功能异常者得分，最终返回所符合的最高分\n" +
                    "process:分析过程，（分析过程请勿提及所依据的打分项或注意事项）" +

                    "首先，根据提供的内容判断肾功能异常是否可用。\n" +
                    "然后，再判断是否有按照肾功能损伤程度（分为：轻度肾功能异常、中度肾功能异常、重度肾功能异常）区分：若是有描述肾功能损伤程度的指标，如：肌酐清除率，或者提到了不同肾功能损伤程度，则需逐个判断，并给出每一项的分值，而你最终给我的分值一定是这几个分值最高的那个分值；若没有描述肾功能损伤程度的指标，也未明确在不同肾功能状态下的使用可行性，那就认为是全部肾功能患者，可用时，给最高分3；不可用时，给最低分0。\n" +
                    "注意事项：\n" +
                    "（1） 如果提供的数据中出现“尚不明确”，或者“尚未进行临床试验研究”等不明确肾功能异常患者是否可用时，请全部视为不可用，给0分。\n" +
                    "（2） 如果提供的数据中出现“禁用”、“忌用”、“不能用”、“不适用”等明确表示肾功能异常患者不可用时，需要给出0分。\n" +
                    "（3） 如果提供的数据中出现“无需调整剂量”或者“减量”这种词，则表示肾功能异常患者可用，只不过需要根据实际情况调整用药剂量，则表示可用，再判断肾功能损伤程度后根据评分规则打分。\n" +
                    "（4） 如果提供的数据中出现“不推荐”、“不建议”等表示不建议肾功能异常患者使用的词语表达时，均表示不可用，给0分。\n" +
                    "（5） 如果提供的数据中给出了轻度/中度/重度肾功能异常者的使用剂量，则认为对应程度的肾功能异常者是可以使用的。如：严重肾功能损害患者的推荐起始剂量为 24/26 mg，2 次/日。认为重度肾功能异常者可用，需要给3分。\\n+" +
                    "'''" +
                    drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency() +
                    "'''";;
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "在肾功能异常患者中的相关内容，" +
                    "并根据给出的分析结果内容对肝功能异常者进行打分，打分规则如下：\n" +
                    "重度肾功能异常可用 3分\n" +
                    "中度肾功能异常可用 1分\n" +
                    "轻度肾功能异常可用 1分\n" +
                    "肾功能异常者不可用 0分\n" +
                    "注意：\n";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();

        stringStringHashMap.put("kidneyScore", " 肾功能得分字段(阿拉伯数字)");
        stringStringHashMap.put("process", "分析过程（中文返回）");

        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = queryAdd + query;
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "specialCrowd_liverKidney", getDemo("process", "kidneyScore"), "","3,2,1,0");
            }else {
                return executeGptPlus(finalQuery, "specialCrowd_liverKidney", responseFormat, "gpt-4o-2024-08-06","3,2,1,0");
            }

        });
    }

    public String getDemo(String content,String score) {
        String x = "作为一个医学工作者，我需要你根据我给出的药品信息以及打分规则进行打分返回json格式数据" +
                "json数据包含字段为："+content+"（String类型）和"+score+"（数字或小数类型）\n" +
                "具体格式如下(只是举例，需要满足下列回答格式，回答内容请对应给出的具体问题以及资料)：\n" +
                "回答：{\""+content+"\":\"打分的相关依据\",\""+score+"\":\"分数\"}；严格按照上述格式返回";
        return x;
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
            query = "请你作为一名专业的临床药师，根据说明书中的药物相互作用相关内容：\n" +
                    drugInfo.getDrugInteraction() +
                    "结合以下评分规则：判断" + drugName + "与其他药物联用时，是否需要调整用药剂量，或者是不能与其他药品在同一时间内一起服用\n" +
                    "无需调整用药剂量 3分\n" +
                    "需要调整用药剂量 1分\n" +
                    "禁止在同一时段使用 1分\n" +
                    "注意：'Score' 单选，当结果符合多条评分规则时，取最高分\n" +
                    "如果提供的数据中出现“无需调整剂量”等词语时，给最高分3分。\n" +
                    "请针对我提供的如下资料" + drugInfo.getDrugInteraction();
        } else {
            query = "请分析临床指南、文献以及药品说明书中，" + drugName + "的药物相互作用相关内容，并根据给出的分析结果内容进行打分，打分规则如下：\n" +
                    "无需调整用药剂量 3分\n" +
                    "需要调整用药剂量 1分\n" +
                    "禁止在同一时段使用 1分\n" +
                    "注意：'Score'单选，当结果符合多条评分规则时，取最高分\n" +
                    "如果提供的数据中出现“无需调整剂量”等词语时，给最高分3分。\n";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        String finalQuery = queryAdd + query;

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "得分（阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程（返回中文）");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(finalQuery, "drugInteraction", getDemo("process", "score"), "","3,2,1");
            }else {
                return executeGptPlus(finalQuery, "drugInteraction", responseFormat, "","3,2,1");
            }

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
        String query = null;
        if (StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions()) || StringUtils.isNotEmpty(drugInfo.getSeriousAdverseRactions()) || StringUtils.isNotEmpty(drugInfo.getAdverseReaction())) {
            query = "请你作为一名专业的临床药师，根据说明书中的不良反应信息：" +
                    ((StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions()) || StringUtils.isNotEmpty(drugInfo.getSeriousAdverseRactions())) ?
                            drugInfo.getCommonAdverseReactions() + drugInfo.getSeriousAdverseRactions() : drugInfo.getAdverseReaction()) + "\n" +
                    "结合以下评分规则：判断使用" + drugName + " 后发生的的不良反应是否均可逆。" +
                    "不良反应均为可逆性 1分\n" +
                    "不良反应为不可逆性 0分\n";
        } else {
            query = "请分析临床指南、文献、药品说明书以及相关政策内容中，" + drugName + "的不良反应是否可逆，" +
                    "并根据给出的分析结果内容进行打分，打分规则如下：\n" +
                    "不良反应均为可逆性 1分\n" +
                    "不良反应为不可逆性 0分\n";
        }
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> objectObjectHashMap = new HashMap<>();
        objectObjectHashMap.put("score", "所得分数（一个得分，只能是一个阿拉伯数字）");
        objectObjectHashMap.put("process", "分析过程(中文返回)");
        JSONObject jsonObject = getResponseFormat(objectObjectHashMap);
        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {

            if (isNew){
                return gptAiUtils.executeGptPlus(queryAdd + finalQuery, "otherAdverseReaction", getDemo("process", "score"), "","1,0");
            }else {
                return executeGptPlus(queryAdd + finalQuery, "otherAdverseReaction", jsonObject, "","1,0");
            }


        });
    }

    private JSONObject genicityAdverseReaction(String drugName, String disease, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        String query = null;
        if (StringUtils.isNotEmpty(drugInfo.getGeneticsReproductionCarcinogenicity())){
            query = "请你作为一名专业的临床药师，根据我提供的相关药品毒理学信息，判断" + drugName + "有无致畸风险或致癌风险。资料如下" +
                    drugInfo.getGeneticsReproductionCarcinogenicity()  +
                    "请结合以下打分规则进行打分：\n" +
                    "无致畸风险 1分\n" +
                    "无致癌风险 1分\n" +
                    "有致畸风险 0分\n" +
                    "有致癌风险 0分\n" +
                    "分析结果请严格采用JSON格式输出。" +
                    "返回的JSON字段包括：score为分数（只能是阿拉伯数字组成），process为分析过程字段。";
        }else {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("score","1");
            jsonObject.put("process","说明书中未提及有致癌或致畸风险。");
            return jsonObject;
        }

        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> objectObjectHashMap = new HashMap<>();
        objectObjectHashMap.put("score", "所得分数（一个得分，只能是一个阿拉伯数字）");
        objectObjectHashMap.put("process", "分析过程(中文回复)");
        JSONObject jsonObject = getResponseFormat(objectObjectHashMap);
        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            if (isNew){
                return gptAiUtils.executeGptPlus(queryAdd + finalQuery, "otherAdverseReaction", getDemo("process", "score"), "","1,0");
            }else {
                return executeGptPlus(queryAdd + finalQuery, "genicityAdverseReaction", jsonObject, "","1,0");
            }

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
                "注意：单选，最高为1分\n";
        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "所得分数（一个得分，只能是一个阿拉伯数字）");
        stringStringHashMap.put("process", "分析过程(中文回复)");
        JSONObject jsonObject = getResponseFormat(stringStringHashMap);

        return (JSONObject) retryer.call(() -> {

            if (isNew){
                return gptAiUtils.executeGptPlus(queryAdd + query, "guideEnterprise", getDemo("process", "score"), "","1,0.5,0");
            }else {
                return executeGptPlus(queryAdd + query, "guideDrugSituation", jsonObject, "","1,0.5,0");
            }


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
        String query = "请结合自身数据库以及相关资讯信息，分析" + enterpirceName + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况，" +
                (StringUtils.isNotEmpty(drugInfo.getManufacturers()) ? drugInfo.getManufacturers() : "") +
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
                "注意：'score'单选（最高为1分）。当结果符合规则中的多条时，取最高的得分结果即可\n" +
                "未知排名情况时，说明情况后，给最低分0分。\n" +
                "*********已知资料*********" +
                "工信部百强" +
                "序号\t企业名称\n" +
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
                "******************" +
                "世界销售前50：" +
                "序号\t企业名称-中文\t企业名称-英文\n" +
                "1\t强生\tJohnson & Johnson\n" +
                "2\t艾伯维\tAbbVie\n" +
                "3\t诺华\tNovartis\n" +
                "4\t默沙东；默克\tMerck & Co.\n" +
                "5\t罗氏\tRoche\n" +
                "6\t辉瑞\tPfizer\n" +
                "7\t百时美施贵宝\tBristol Myers Squibb\n" +
                "8\t阿斯利康\tAstraZeneca\n" +
                "9\t赛诺菲\tSanofi\n" +
                "10\t葛兰素史克\tGSK\n" +
                "11\t诺和诺德\tNovo Nordisk\n" +
                "12\t礼来\tEli Lilly\n" +
                "13\t武田\tTakeda\n" +
                "14\t安进\tAmgen\n" +
                "15\t吉利德科学\tGilead Science\n" +
                "16\t勃林格殷格翰\tBoehringer Ingelheim\n" +
                "17\t拜耳\tBayer\n" +
                "18\t晖致\tViatris\n" +
                "19\tCSL\tCSL\n" +
                "20\t梯瓦\tTeva Pharmaceutical Industries\n" +
                "21\t安斯泰来\tAstellas Pharma\n" +
                "22\t福泰制药\tVertex Pharmaceuticals\n" +
                "23\t山德士集团\tSandoz Group\n" +
                "24\t默克集团\tMerck KGaA\n" +
                "25\t第一三共\tDaiichi Sankyo\n" +
                "26\t大冢\tOtsuka Holdings\n" +
                "27\t渤健\tBiogen\n" +
                "28\t再生元\tRegeneron Pharmaceuticals\n" +
                "29\t美德纳\tModerna\n" +
                "30\t欧加隆\tOrganon\n" +
                "31\t基立福\tGrifols\n" +
                "32\t太阳制药\tSun Pharmaceutical Industries\n" +
                "33\t云南白药\tYunnan Baiyao Group\n" +
                "34\t优时比\tUCB\n" +
                "35\t施维雅\tLES LABORATOIRES SERVIER\n" +
                "36\t雅培\tAbbott Laboratories\n" +
                "37\t费森尤斯\tFresenius\n" +
                "38\t中国生物制药\tSino Biopharmaceutical\n" +
                "39\t博士康\tBausch Health Companies\n" +
                "40\t卫材\tEisai\n" +
                "41\t三菱化学集团\tMitsubishi Chemical Group\n" +
                "42\t上海医药集团\tShanghai Pharmaceuticals Holding\n" +
                "43\t中外制药\tChugai Pharmaceutical\n" +
                "44\t史达德\tSTADA Arzneimittel\n" +
                "45\t美纳里尼\tMenarini\n" +
                "46\t爵士制药\tJazz Pharmaceuticals\n" +
                "47\t益普生\tIpsen\n" +
                "48\t江苏恒瑞医药\tJiangsu Hengrui Medicine\n" +
                "49\t因塞特\tIncyte\n" +
                "50\t瑞迪博士实验室\tDr.Reddy's Laboratories\n";
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        JSONObject guideEnterprise = (JSONObject) retryer.call(() -> {

            if(isNew){
                return gptAiUtils.executeGptPlus(queryAdd + query, "guideEnterprise", getDemo("process","score"), "","1,0.8,0.6,0.4,0.2,0");
            }else {
                return executeGptPlus(queryAdd + query, "guideEnterprise", responseFormat, "","1,0.8,0.6,0.4,0.2,0");
            }

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
        String query = (StringUtils.isNotEmpty(drugInfo.getGlobalUsage()) ? "请根据如下内容" + drugInfo.getGlobalUsage() : "请根据药品注册信息、药品评审信息、国家药品监督管理局等官方网站或相关资讯，及自身知识库") +
                "，分析" + drugName + "的销售情况，" +
                "并根据分析结果内容进行打分，打分规则如下：\n" +
                "中国、美国、欧洲、日本均已上市  1分\n" +
                "国内外均有销售  0.5分\n" +
                "注意：'Score' 单选（最高为1分）。当结果符合规则中的多条时，取最高的得分结果即可\n" +
                "未知情况时，说明情况后，给最低分0分。\n";
        Retryer retryer = GuavaRetryer.createRetryer();
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "分数（只能是阿拉伯数字组成）");
        stringStringHashMap.put("process", "分析过程");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        return (JSONObject) retryer.call(() -> {
//            return executeGptPlus(queryAdd + query, "guideCountry", responseFormat, "","1,0.5,0");
            String demo = getDemo("process", "score");
            return gptAiUtils.executeGptPlus(queryAdd + query, "guideCountry", demo,"","1,0.5,0");
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
            return executeGpt(query, "guide_sdy","");
        });
    }


    private JSONObject guide_sdyPc(String drugName, String disease, String pdf_txt, String title, DrugInfoNew drugInfo) throws ExecutionException, RetryException {
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
        String query = "请根据" + title + "中的原文内容:'" + pdf_txt + "'" +
                "汇总出一段" + drugName + "治疗" + disease + "的有效性相关结论，并根据已给出的以上信息以及以下评分规则给出一个评分(评分是针对这篇指南进行打分的)：" +
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
            return executeGpt(query, "guide_sdy","");
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
        if (StrUtil.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
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
                    "提供的资料如下：" + drugInfo.getSeriousAdverseRactions();
        } else if (StrUtil.isNotBlank(drugInfo.getAdverseReaction())) {
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
                    "Score：就低原则：符合细则中多项描述时，以最低得分项为准。\n";
        }

        Retryer retryer = GuavaRetryer.createRetryer();

        HashMap<String, String> stringStringHashMap = new HashMap<>();
        stringStringHashMap.put("score", "最终得分，返回必须是一个阿拉伯数字");
        stringStringHashMap.put("process", "分析过程，返回必须是一段文字");
        JSONObject responseFormat = getResponseFormat(stringStringHashMap);

        String finalQuery = query;
        return (JSONObject) retryer.call(() -> {
            return executeGptPlus(finalQuery, "adverseReaction", responseFormat, "","");
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
                (StringUtils.isNotEmpty(drugInfo.getSafeAdvantage()) ? "相关信息：" + drugInfo.getSafeAdvantage() : "") +
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
            return executeGpt(query, "adverseReaction","4,0");
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
            return executeGpt(finalQuery, "specialCrowd_childrenMedicine_infant_sdy","");
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
            return executeGpt(finalQuery, "specialCrowd_childrenMedicine_sdy","");
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
            return executeGpt(finalQuery, "specialCrowd_pregnantWomen_sdy","");
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
        if (StringUtils.isNotEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
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
                    "请针对我提供的如下资料：" + drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction();
            ;
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
            return executeGpt(finalQuery, "specialCrowd_liver_sdy","");
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
        if (StrUtil.isNotBlank(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
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
                    "请针对我提供的如下资料：" + drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction();
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
            return executeGpt(finalQuery, "specialCrowd_liver_sdy","");
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
            return executeGpt(queryAdd + query, "pharmacovigilance_sdy","");
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
        String query = (StringUtils.isNotEmpty(drugInfo.getTreatmentAdvantage()) ? "请根据我提供的材料分析" + drugInfo.getTreatmentAdvantage() + "\n" : "请分析临床指南、文献、临床试验数据库，以及知识库中") +
                "，与同类药品相比，" + drugName + "治疗" + disease + "在临床疗效方面有哪些特别优势。" +
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
            return executeGpt(queryAdd + query, "advantage_sdy","");
        });
    }


    // ##############################业务代码##################################


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

    /**
     * 初始化 drugInfoNew
     *
     * @return
     */


    @Deprecated
    @Override
    public JSONObject guidePanel(String drugInfo, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId) {
        JSONObject result = new JSONObject();

        String[] arr = drugInfo.split("-");
        String drugName = arr[0];
        String enterpriseName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];

        result.put("disease", disease);
        result.put("ts", System.currentTimeMillis());
        result.put("cache_key", drugInfo + "_" + disease);

        // 用来存放drug 和 disease同义词list
        List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
        disease = disease.replaceAll(" ", "");
        List<String> diseases = new ArrayList<>(Collections.singletonList(disease));
        ArrayList<String> stringBuilder = new ArrayList<>();
        long begin = System.currentTimeMillis();
        // 开始分析的步骤开始 计入redis中
        int step = 0;

        // 获取同义词
//        GetSynonyms(drugName, drugs, disease, diseases);

        // 此处存储的key 与 value 的值在获取同义词接口出保存
        String redis_key = "synonym:" + userId;
        String synonym = RedisUtils.getStr(redis_key);
        if (StrUtil.isNotBlank(synonym)) {
            List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {
            });
            for (SynonymVo synonymVo : synonymVos) {
                // 表明输入词有药
                if (Integer.parseInt(synonymVo.getType()) == 1) {
                    // 要所有已勾选的同义词
                    drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
                    // 排除所有反勾选的同义词
                    drugs.removeAll(synonymVo.getExcludeSynonyms());
                }

                // 如果在研究疾病清单处自定义疾病  那么前一个页面中如果自定义了同义词就不再使用 否则需要使用自定义的同义词
                if (Integer.parseInt(isCustom) == 0) {
                    if (Integer.parseInt(synonymVo.getType()) == 3) {
                        // 要所有已勾选的同义词
                        diseases = new ArrayList<>(CollUtil.union(diseases, synonymVo.getSynonyms()));
                        // 排除所有反勾选的同义词
                        diseases.removeAll(synonymVo.getExcludeSynonyms());
                    }
                }
            }
        }


        DrugInfoNew drugInfo1 = null;
        if (Objects.nonNull(specifications) && StrUtil.isNotBlank(specifications)) {
            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
        }
        if (drugInfo1 == null) {
            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
        }
        DrugAddDto drugAdd = null;
        if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
            drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
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


                if (approveCode.getPoison() != null && !approveCode.getPoison().isEmpty()) {
                    drugInfo1.setPoison(delHTMLTag(approveCode.getPoison()));
                }
                if (approveCode.getDrugWarning() != null && !approveCode.getDrugWarning().isEmpty()) {
                    drugInfo1.setDrugWarning(delHTMLTag(approveCode.getDrugWarning()));
                }

            }
        }
        if (StringUtils.isNotEmpty(drugInfo1.getPharmacology())) {
            drugInfo1.setHasPharmacology(true);
        }
        if (StringUtils.isNotEmpty(drugInfo1.getPharmacokinetics())) {
            drugInfo1.setHasPharmacokinetics(true);
        }

        // 合理用药
        if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
            JSONObject evaluationMedicine = evaluationService.getHeliYongYao(drugInfo1.getDrugZh());
            if (ObjectUtil.isEmpty(evaluationMedicine)) {
                List<JSONObject> evaluationMedicines = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugInfo1.getDrugSynonymZh())), JSONObject.class, CommonConstants.REASONABLE_DRUG_TABLE_NAME);
                if (CollUtil.isNotEmpty(evaluationMedicines)) {
                    evaluationMedicine = evaluationMedicines.get(0);
                }
            }
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
                        (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringLactation")) ||
                                CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                    drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("medicationDuringLactation")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                }


                if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                    drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                }

                if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                    drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warning")));
                }


            }
        }

        // 药品添加说明书
        if (ObjectUtil.isNotEmpty(drugAdd)) {
            BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
            StringBuilder usageAndDosage = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
            }

            if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(drugAdd.getKidneyPatients());
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾功能异常者：" + drugAdd.getKidneyPatients());
            }
            if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(drugAdd.getLiverPatients());
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝功能异常者：" + drugAdd.getLiverPatients());
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

            if (StringUtils.isNotEmpty(drugAdd.getAccessory())) {
                String s = drugInfo1.getIngredient().replaceAll("\\n$", "");
                drugInfo1.setIngredient(s + "\n辅料：" + drugAdd.getAccessory());
            }

        } else {
            drugAdd = new DrugAddDto();
        }

        // 获取检索时所填的信息
        JSONObject drugData = mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId)), JSONObject.class, "drug_data");
        if (ObjectUtil.isNotEmpty(drugData)) {
            JSONArray list = drugData.getJSONArray("list");
            for (JSONObject jsonObject : list.toJavaList(JSONObject.class)) {
                if (drugInfo1.getId().equals(jsonObject.getString("drugId")) && (disease).equals(jsonObject.getString("disease"))) {
                    // 价格
                    drugInfo1.setSaveDrugPrice(JSONObject.parseObject(String.valueOf(jsonObject.getJSONObject("drugPrice")), SaveDrugPrice2.class));
                    // 指南
                    List<GuidelinesVo> guide = jsonObject.getJSONArray("guide").toJavaList(GuidelinesVo.class);
                    List<GuidelinesVo> literature = jsonObject.getJSONArray("literature").toJavaList(GuidelinesVo.class);
                    guide.addAll(literature);
                    drugInfo1.setGuidelinesVo(guide);
                    // 说明书详情
                    DrugDisData drugDisData = JSONObject.parseObject(String.valueOf(jsonObject), DrugDisData.class);
                    drugInfo1.setIndicationx(drugDisData.getIndication());
                    drugInfo1.setClinical(drugDisData.getClinical());
                    drugInfo1.setManufacturers(drugDisData.getManufacturers());
                    drugInfo1.setGlobalUsage(drugDisData.getGlobalUsage());
                    InstructionDataVo info = drugDisData.getInfo();
                    drugInfo1.setPharmacology(info.getPharmacology());
                    drugInfo1.setPharmacokinetics(info.getPharmacokinetics());
                    drugInfo1.setAdverseReaction(info.getAdverseReaction());
                    drugInfo1.setCommonAdverseReactions(info.getCommonAdverseReactions());
                    drugInfo1.setSeriousAdverseRactions(info.getSeriousAdverseReactions());


                }
            }

            // 价格信息


        }

        String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
        addProcess(id, step++, "<p class='text_title'>基于《中国医疗机构药品评价与遴选快速指南(第二版)》中的评价量表，对" + drugNameDetail + "治疗" + disease + "进行临床综合评价：</p>", stringBuilder);

        DrugDataInfoDto drugDataInfoDto = mongoTemplate.findOne(new Query(Criteria.where("_id").is(searchId)), DrugDataInfoDto.class);
        assert ObjectUtil.isNotEmpty(drugDataInfoDto);
        // 获取对应的文献
        List<GuideVO> guideVOS = new ArrayList<>();
//        List<DataVo<List<GuidelinesVo>>> guidelines = drugDataInfoDto.getGuidelines();
//        for (DataVo<List<GuidelinesVo>> guideline : guidelines) {
//            if (guideline.getDrugId().equals(drugId)){
//                for (GuidelinesVo datum : guideline.getData()) {
//                    GuideVO guideVO = new GuideVO();
//                    guideVO.setTitle(datum.getTitle());
//                    guideVO.setPdf_txt(datum.getContent());
//                    guideVO.setId(datum.getId());
//                    guideVO.setFbdate(datum.getFdaDate());
//                    guideVO.setZdz(datum.getZdz());
//                }
//                break;
//            }
//        }

        // 其他属相替换
//       DrugToModel drugToModel = getDrugToModel(drugAdd,drugInfo1,drugDataInfoDto);

        Map<String, Future<Boolean>> futureResult_app = new HashMap<>();
        Map<String, JSONObject> gptAnalysisMap_app = new HashMap<>();
        ArrayList<GuideDto> guideEffectiveMap_app = new ArrayList<>();
        Map<GuideVO, JSONObject> guideOldEffectiveMap_app = new HashMap<>();
        Map<Literature, JSONObject> literatureMap_app = new HashMap<>();

        useThreadPoolExecutePromptPc(drugName, disease, drugInfo1, enterpriseName, futureResult_app, gptAnalysisMap_app, guideEffectiveMap_app, guideOldEffectiveMap_app, literatureMap_app, drugAdd, new ArrayList<>(), new ArrayList<>());

        // 1.药学特性分析
        step = pharmacyAnalysis(drugName, disease, drugInfo1, step, id, result, stringBuilder);

        // 2.有效性部分
        step = effectiveAnalysisPc(drugName, disease, drugInfo1, step, id, result, futureResult_app, gptAnalysisMap_app, guideEffectiveMap_app, guideOldEffectiveMap_app, literatureMap_app, stringBuilder);

        // 3.安全性
        step = safetyAnalysis(drugName, disease, drugInfo1, step, id, result, futureResult_app, gptAnalysisMap_app, stringBuilder);

        // 4.经济性
        step = economicalAnalysis(drugName, disease, drugInfo1, step, id, result, priceId, enterpriseName, stringBuilder);

        // 5.其他
        step = otherAnalysis(drugName, disease, drugInfo1, step, id, result, enterpriseName, futureResult_app, gptAnalysisMap_app, stringBuilder);

        String uuid = UUID.randomUUID().toString();
        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
        result.put("id", uuid);
        result.put("_id", uuid);
        result.put("drugName", drugName);
        result.put("disease", disease);
        StringBuilder drugInfoSB = new StringBuilder();
        if (StrUtil.isNotBlank(drugName)) {
            drugInfoSB.append(drugName).append("-");
        }
        if (StrUtil.isNotBlank(specifications)) {
            drugInfoSB.append(specifications).append("-");
        }
        if (StrUtil.isNotBlank(enterpriseName)) {
            drugInfoSB.append(enterpriseName);
        }
        drugInfo = drugInfoSB.toString();
        result.put("drugInfo", drugInfo);
        this.mongoTemplate.insert(result, "drug_analyze_data");

        log.info(result.toJSONString());
        addProcess(id, step, "-END-", stringBuilder);
        log.info("剩余代码执行花费时长{}", System.currentTimeMillis() - begin);
        return result;
    }

    private DrugToModel getDrugToModel(DrugAddDto drugAdd, DrugInfoNew drugInfo1, DrugDataInfoDto drugDataInfoDto) {
        String id = drugInfo1.getId();


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
                usageAndDosage.append("肾病是否可用:" + drugAdd.getKidneyPatients() + "\n");
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾功能异常者：" + drugAdd.getKidneyPatients());
            }
            if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                usageAndDosage.append("肝病是否可用:" + drugAdd.getLiverPatients() + "\n");
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝功能异常者：" + drugAdd.getLiverPatients());
            }
            if (usageAndDosage.length() > 0) {
                drugInfo1.setUsageAndDosage(usageAndDosage.toString());
            }
            StringBuilder adverseReaction = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
            }
            if (adverseReaction.length() > 0) {
                drugInfo1.setAdverseReaction(adverseReaction.toString());
            }

        } else {
            drugAdd = new DrugAddDto();
        }

        DrugToModel drugToModel = new DrugToModel();
        // 说明书
        List<DataVo<InstructionDataVo>> instructions = drugDataInfoDto.getInstructions();
        for (DataVo<InstructionDataVo> instruction : instructions) {
            if (instruction.getDrugId().equals(id)) {
                InstructionDataVo data = instruction.getData();
                String adverseReaction = data.getAdverseReaction();
                String pharmacokinetics = data.getPharmacokinetics();
                String pharmacology = data.getPharmacology();

                drugToModel.setModerateAdverseReaction(adverseReaction);
                drugToModel.setPharmacokinetics(pharmacokinetics);
                drugToModel.setPharmacology(pharmacology);
            }
        }

        BeanUtil.copyPropertiesOnlyNull(drugInfo1, drugToModel);


        return drugToModel;
    }

    @Override
    public JSONObject sdyPanelApp_bak(String drugName, String disease, String id, String priceId) {
        return null;
    }

    public void useThreadPoolExecutePrompt(String drugName, String disease, DrugInfoNew drugInfo,
                                           String enterpriseName, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap,
                                           Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                           Map<Literature, JSONObject> literatureMap, DrugAddDto drugAdd, List<String> drugs, List<String> diseases) {


        Future<Boolean> adverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.1 重度和中度不良反应
            long begin_adverseReaction = System.currentTimeMillis();
            JSONObject adverseReaction = new JSONObject();
            try {
                JSONObject jsonObject = this.commonAdverseReaction(drugName, disease, drugInfo);
                JSONObject jsonObject1 = this.seriousAdverseReaction(drugName, disease, drugInfo);
                adverseReaction.put("severeAdverseReaction", jsonObject1.getString("severeAdverseReaction"));
                adverseReaction.put("mildAdverseReaction", jsonObject.getString("adverseReaction"));
                adverseReaction.put("mildAdverseReactionScore", jsonObject.getString("mildAdverseReactionScore"));
                adverseReaction.put("severeAdverseReactionScore", jsonObject1.getString("severeAdverseReactionScore"));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
//                if (adverseReaction.getString("severeAdverseReaction") == null) {
//                    adverseReaction.put("severeAdverseReaction", "暂无相关内容");
//                }
//                if (adverseReaction.getString("mildAdverseReaction") == null) {
//                    adverseReaction.put("mildAdverseReaction", "暂无相关内容");
//                }
                String severeAdverseReaction = adverseReaction.getString("severeAdverseReaction");
                severeAdverseReaction = severeAdverseReaction.replaceFirst("\\[", "");
                severeAdverseReaction = severeAdverseReaction.replaceFirst("\\]", "");
                adverseReaction.put("severeAdverseReaction", severeAdverseReaction);

                if (adverseReaction.getString("mildAdverseReaction") == null) {
                    adverseReaction.put("mildAdverseReaction", "");
                }
                String mildAdverseReaction = adverseReaction.getString("mildAdverseReaction");
                mildAdverseReaction = mildAdverseReaction.replaceFirst("\\[", "");
                mildAdverseReaction = mildAdverseReaction.replaceFirst("\\]", "");
                adverseReaction.put("mildAdverseReaction", mildAdverseReaction);

                if (adverseReaction.getString("mildAdverseReactionScore") == null) {
                    adverseReaction.put("mildAdverseReactionScore", 0);
                }
                if (adverseReaction.getString("severeAdverseReactionScore") == null) {
                    adverseReaction.put("severeAdverseReactionScore", 0);
                }

                boolean mildAdverseReactionScore = false;
                boolean severeAdverseReactionScore = false;
                if (StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions())) {
                    double v = extractMaxPercentage(drugInfo.getCommonAdverseReactions());
                    if (v > 0) {
                        mildAdverseReactionScore = true;
                    }
                    adverseReaction.put("mildAdverseReaction", drugInfo.getCommonAdverseReactions());
                    adverseReaction.put("mildAdverseReactionScore", v);
                }
                if (StringUtils.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
                    double v = extractMaxPercentage1(drugInfo.getSeriousAdverseRactions());
                    if (v > 0) {
                        severeAdverseReactionScore = true;
                    }
                    adverseReaction.put("severeAdverseReaction", drugInfo.getSeriousAdverseRactions());
                    adverseReaction.put("severeAdverseReactionScore", v);
                }
//                if (!mildAdverseReactionScore||!severeAdverseReactionScore){
//                    JSONObject jsonObject = extractMaxPercentageGpt(drugInfo);
//                    if (!mildAdverseReactionScore&&ObjectUtil.isNotEmpty(jsonObject)){
//                        adverseReaction.put("mildAdverseReaction", jsonObject.getString("content1"));
//                        adverseReaction.put("mildAdverseReactionScore", jsonObject.getString("score1"));
//                    }
//                    if (!severeAdverseReactionScore&&ObjectUtil.isNotEmpty(jsonObject)){
//                        adverseReaction.put("severeAdverseReaction", jsonObject.getString("content2"));
//                        adverseReaction.put("severeAdverseReactionScore", jsonObject.getString("score2"));
//                    }
//
//                }
            }

            gptAnalysisMap.put("adverseReaction", adverseReaction);
            log.info("adverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_adverseReaction);
            return true;
        });
        futureResult.put("adverseReaction", adverseReactionResult);
//        Future<Boolean> literatureResult = gptAnalysisThreadPool.submit(() -> {
//            List<Literature> literatureList = queryLiterature(drugName, drugs, disease, diseases);
//            if (literatureList.size() >= 2) {
//                literatureList = literatureList.subList(0, 2);
//            }
//
//            for (int i = 0; i < literatureList.size(); i++) {
//                int trail = i + 1;
//                Literature literature = literatureList.get(i);
//                Future<Boolean> literatureResult_trail = gptAnalysisThreadPool.submit(() -> {
//                    long begin_literature = System.currentTimeMillis();
//                    JSONObject guide = new JSONObject();
//                    try {
//                        String summary = literature.getSummary();
//                        String title = literature.getTitle();
//                        guide = this.literature(drugName, disease, summary, title, drugInfo);
//                    } catch (Exception e) {
//                        log.error(e.getMessage(), e);
//                    } finally {
//                        if (guide.getString("score") == null) {
//                            guide.put("score", 0);
//                        }
//                        if (guide.getString("process") == null) {
//                            guide.put("process", "");
//                        }
//                    }
//                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_literature);
//
//                    literatureMap.put(literature, guide);
//                    return true;
//                });
//                futureResult.put("literature_" + trail, literatureResult_trail);
//            }
//            return true;
//        });
//        futureResult.put("literatureResult", literatureResult);


        Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
            try {
                if (StringUtils.isNotEmpty(drugInfo.getDrugZh())) {
                    GetSynonyms(drugInfo.getDrugZh(), drugs, disease, diseases);
                }else {
                    GetSynonyms(drugInfo.getDrugName(), drugs, disease, diseases);
                }
                List<String> list = gptCallUtil.splitDisease(disease);
                diseases.addAll(list);
            }catch (Exception e){
                log.error("disease split error:{}",e);
            }

            GuideAndScore mustGuideByDrugAndDisease = guideSearch.sdyPanel(drugInfo.getDrugZh(),  disease, drugs, diseases);
            List<GuideVO> guideVOList = mustGuideByDrugAndDisease.getGuideVOS();
            String score = mustGuideByDrugAndDisease.getScore();
            String finalScore = score;

            Future<Boolean> indicationResult = gptAnalysisThreadPool.submit(() -> {
                // 2.1 适应症
                long begin_indication = System.currentTimeMillis();
                JSONObject indication = new JSONObject();
                try {
                    if (CollUtil.isNotEmpty(guideVOList)) {
                        indication = this.clinical(drugName, disease, drugInfo, guideVOList);
                    } else {
                        indication = this.indication(drugName, disease, drugInfo);
                    }

                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (indication.getString("score") == null) {
                        indication.put("score", 0);
                    }
                    if (indication.getString("process") == null) {
                        indication.put("process", "");
                    }
                }
                log.info("indication  gpt  分析时长{}", System.currentTimeMillis() - begin_indication);

                gptAnalysisMap.put("indication", indication);
                return true;
            });
            futureResult.put("indication", indicationResult);


            List<GuideVO> finalGuideVOList = guideVOList;

            Future<Boolean> clinicalResult = gptAnalysisThreadPool.submit(() -> {
                // 2.3 临床疗效
                long begin_clinical = System.currentTimeMillis();
                JSONObject clinical = new JSONObject();
                try {
                    clinical = this.clinicalx(drugName, disease, drugInfo);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (clinical.getString("score") == null) {
                        clinical.put("score", 0);
                    }
                    if (clinical.getString("process") == null) {
                        clinical.put("process", "");
                    }
                }
                log.info("clinical  gpt  分析时长{}", System.currentTimeMillis() - begin_clinical);

                gptAnalysisMap.put("clinical", clinical);
                return true;
            });
            futureResult.put("clinical", clinicalResult);


            for (int i = 0; i < finalGuideVOList.size(); i++) {
                if (i > 20) {
                    return true;
                }
                int trail = i + 1;
                GuideVO guideVO = finalGuideVOList.get(i);
                Future<Boolean> guideResult_trail = gptAnalysisThreadPool.submit(() -> {
                    long begin_guide = System.currentTimeMillis();
                    JSONObject guide = new JSONObject();
                    try {
                        // String pdf_txt = guideVO.getPdf_txt();
                        // String zdz = guideVO.getZdz();
                        String title = guideVO.getTitle();
                        // guide = this.guide(drugName, disease, pdf_txt, zdz, title, drugInfo);
                        guide.put("score",guideVO.getScorex());
                        guide.put("process",guideVO.getGuideInfo());
                        log.info("指南评分:{}", title);
                        log.info("指南评分:{}", guide.getString("score"));
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guide.getString("score") == null) {
                            guide.put("score", 0);
                        }
                        if (guide.getString("process") == null) {
                            guide.put("process", "");
                        }

                        if (Double.parseDouble(formatScore(finalScore)) != 0) {
                            guide.put("score", formatScore(finalScore));
                        }

                    }
                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);

                    guideEffectiveMap.put(guideVO, guide);
                    return true;
                });
                futureResult.put("mainGuide_" + trail, guideResult_trail);
            }
            return true;
        });
        futureResult.put("guideResult", guideResult);


        Future<Boolean> specialCrowd_pregnantWomenResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-孕妇及哺乳期妇女
            long begin_specialCrowd_pregnantWomen = System.currentTimeMillis();
            JSONObject specialCrowd_pregnantWomen = new JSONObject();
            try {
                specialCrowd_pregnantWomen = this.specialCrowd_pregnantWomen(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_pregnantWomen.getString("pregnantScore") == null) {
                    specialCrowd_pregnantWomen.put("pregnantScore", 0);
                }
                if (specialCrowd_pregnantWomen.getString("lactatingScore") == null) {
                    specialCrowd_pregnantWomen.put("lactatingScore", 0);
                }
                if (StringUtils.isNotEmpty(drugInfo.getPregnant())) {
                    specialCrowd_pregnantWomen.put("pregnantProcess", drugInfo.getPregnant());
                }
                if (StringUtils.isNotEmpty(drugInfo.getLactation())) {
                    specialCrowd_pregnantWomen.put("lactatingProcess", drugInfo.getLactation());
                }
                if (specialCrowd_pregnantWomen.getString("lactatingProcess") == null && specialCrowd_pregnantWomen.getString("pregnantProcess") == null) {
                    specialCrowd_pregnantWomen.put("process", specialCrowd_pregnantWomen.getString("lactatingProcess") + "\n" + specialCrowd_pregnantWomen.getString("pregnantProcess"));
                } else {
                    specialCrowd_pregnantWomen.put("process", "");
                }


            }
            log.info("specialCrowd_pregnantWomen  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen);
            gptAnalysisMap.put("specialCrowd_pregnantWomen", specialCrowd_pregnantWomen);
            return true;
        });
        futureResult.put("specialCrowd_pregnantWomen", specialCrowd_pregnantWomenResult);


        Future<Boolean> specialCrowd_childrenMedicineResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-儿童
            long begin_specialCrowd_childrenMedicine = System.currentTimeMillis();
            JSONObject specialCrowd_childrenMedicine = new JSONObject();
            try {
                specialCrowd_childrenMedicine = this.specialCrowd_childrenMedicine(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_childrenMedicine.getString("score") == null) {
                    specialCrowd_childrenMedicine.put("score", 0);
                }
                if (specialCrowd_childrenMedicine.getString("process") == null) {
                    specialCrowd_childrenMedicine.put("process", "");
                }
            }
            log.info("specialCrowd_childrenMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_childrenMedicine);

            gptAnalysisMap.put("specialCrowd_childrenMedicine", specialCrowd_childrenMedicine);
            return true;
        });
        futureResult.put("specialCrowd_childrenMedicine", specialCrowd_childrenMedicineResult);


        Future<Boolean> specialCrowd_geriatricMedicineResult = gptAnalysisThreadPool.submit(() -> {
            // 3.3 特殊人群-老年
            long begin_specialCrowd_geriatricMedicine = System.currentTimeMillis();
            JSONObject specialCrowd_geriatricMedicine = new JSONObject();
            try {
                specialCrowd_geriatricMedicine = this.specialCrowd_geriatricMedicine(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_geriatricMedicine.getString("score") == null) {
                    specialCrowd_geriatricMedicine.put("score", 0);
                }
                if (specialCrowd_geriatricMedicine.getString("process") == null) {
                    specialCrowd_geriatricMedicine.put("process", "");
                }
            }
            log.info("specialCrowd_geriatricMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_geriatricMedicine);

            gptAnalysisMap.put("specialCrowd_geriatricMedicine", specialCrowd_geriatricMedicine);
            return true;
        });
        futureResult.put("specialCrowd_geriatricMedicine", specialCrowd_geriatricMedicineResult);


        Future<Boolean> specialCrowd_liverKidneyResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-肝肾功能异常者
            long begin_specialCrowd_liverKidney = System.currentTimeMillis();
            JSONObject specialCrowd_liverKidney = new JSONObject();
            JSONObject specialCrowd_liver = new JSONObject();
            JSONObject specialCrowd_Kidney = new JSONObject();
            try {
                specialCrowd_liver = specialCrowd_liver(drugName, disease, drugInfo);
                specialCrowd_Kidney = specialCrowd_Kidney(drugName, disease, drugInfo);


            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {


                if (specialCrowd_liver.getString("liverScore") == null) {
                    specialCrowd_liver.put("liverScore", 0);
                }
                if (specialCrowd_Kidney.getString("kidneyScore") == null) {
                    specialCrowd_Kidney.put("kidneyScore", 0);
                }


                specialCrowd_liverKidney.put("kidneyScore", specialCrowd_Kidney.getString("kidneyScore"));
                specialCrowd_liverKidney.put("kidneyProcess", specialCrowd_Kidney.getString("process"));

                specialCrowd_liverKidney.put("liverScore", specialCrowd_liver.getString("liverScore"));
                specialCrowd_liverKidney.put("liverProcess", specialCrowd_liver.getString("process"));

                // if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency()) && StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                //     specialCrowd_liverKidney.put("liverScore", 3);
                //     specialCrowd_liverKidney.put("kidneyScore", 3);
                //     specialCrowd_liverKidney.put("process", "未找到肝、肾功能不全者剂量调整信息。");
                // } else {
                //
                //     if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                //         specialCrowd_liverKidney.put("liverScore", 3);
                //         specialCrowd_liverKidney.put("kidneyScore", specialCrowd_Kidney.getString("kidneyScore"));
                //         specialCrowd_liverKidney.put("process", "未找到肝功能不全者剂量调整信息。\n" + drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                //         specialCrowd_liverKidney.put("liverProcess", "未找到肝功能不全者剂量调整信息。");
                //         specialCrowd_liverKidney.put("kidneyProcess", drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                //     } else if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                //         specialCrowd_liverKidney.put("kidneyScore", 3);
                //         specialCrowd_liverKidney.put("liverScore", specialCrowd_liver.getString("liverScore"));
                //         specialCrowd_liverKidney.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() + "\n未找到肾功能不全者剂量调整信息。");
                //         specialCrowd_liverKidney.put("liverProcess", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction());
                //         specialCrowd_liverKidney.put("kidneyProcess", "未找到肾功能不全者剂量调整信息。");
                //     } else {
                //         specialCrowd_liverKidney.put("liverScore", specialCrowd_liver.getString("liverScore"));
                //         specialCrowd_liverKidney.put("kidneyScore", specialCrowd_Kidney.getString("kidneyScore"));
                //         specialCrowd_liverKidney.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() + "\n" + drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                //         specialCrowd_liverKidney.put("liverProcess", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction());
                //         specialCrowd_liverKidney.put("kidneyProcess", drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                //     }
                // }
            }
            log.info("specialCrowd_liverKidney  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liverKidney);

            gptAnalysisMap.put("specialCrowd_liverKidney", specialCrowd_liverKidney);
            gptAnalysisMap.put("specialCrowd_liver", specialCrowd_liver);
            gptAnalysisMap.put("specialCrowd_Kidney", specialCrowd_Kidney);
            return true;
        });
        futureResult.put("specialCrowd_liverKidney", specialCrowd_liverKidneyResult);


        Future<Boolean> drugInteractionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.3 药物相互作用
            long begin_drugInteraction = System.currentTimeMillis();
            JSONObject drugInteraction = new JSONObject();
            try {
                drugInteraction = this.drugInteraction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (drugInteraction.getString("score") == null) {
                    drugInteraction.put("score", 0);
                }
                if (drugInteraction.getString("process") == null) {
                    drugInteraction.put("process", "");
                }
            }
            log.info("drugInteraction  gpt  分析时长{}", System.currentTimeMillis() - begin_drugInteraction);

            gptAnalysisMap.put("drugInteraction", drugInteraction);
            return true;
        });
        futureResult.put("drugInteraction", drugInteractionResult);


        Future<Boolean> otherAdverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.4 其他不良反应
            long begin_otherAdverseReaction = System.currentTimeMillis();
            JSONObject otherAdverseReaction = new JSONObject();
            try {
                otherAdverseReaction = this.otherAdverseReaction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (otherAdverseReaction.getString("score") == null) {
                    otherAdverseReaction.put("score", 0);
                }
                if (otherAdverseReaction.getString("process") == null) {
                    otherAdverseReaction.put("process", "");
                }
                String process = otherAdverseReaction.getString("process");
                process = process.replaceFirst("\\{", "");
                process = process.replaceFirst("\\}", "");
                otherAdverseReaction.put("process", process);
            }
            log.info("otherAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_otherAdverseReaction);

            gptAnalysisMap.put("otherAdverseReaction", otherAdverseReaction);
            return true;
        });
        futureResult.put("otherAdverseReaction", otherAdverseReactionResult);


        Future<Boolean> genicityAdverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.4 其他不良反应
            long begin_genicityAdverseReaction = System.currentTimeMillis();
            JSONObject genicityAdverseReaction = new JSONObject();
            try {
                genicityAdverseReaction = this.genicityAdverseReaction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (genicityAdverseReaction.getString("score") == null) {
                    genicityAdverseReaction.put("score", 0);
                }
                if (genicityAdverseReaction.getString("process") == null) {
                    genicityAdverseReaction.put("process", "");
                }
                String process = genicityAdverseReaction.getString("process");
                process = process.replaceFirst("\\{", "");
                process = process.replaceFirst("\\}", "");
                genicityAdverseReaction.put("process", process);
//                if (StringUtils.isNotEmpty(drugInfo.getGeneticsReproductionCarcinogenicity()) || StringUtils.isNotEmpty(drugInfo.getPoison())) {
//                    process = StringUtils.isNotEmpty(drugInfo.getGeneticsReproductionCarcinogenicity()) ? drugInfo.getGeneticsReproductionCarcinogenicity() : drugInfo.getPoison();
//                    genicityAdverseReaction.put("process", process);
//                } else {
//                    genicityAdverseReaction.put("process", "未发现致癌性与致畸性");
//                    genicityAdverseReaction.put("score", 1);
//                }


            }
            log.info("genicityAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_genicityAdverseReaction);

            gptAnalysisMap.put("genicityAdverseReaction", genicityAdverseReaction);
            return true;
        });
        futureResult.put("genicityAdverseReaction", genicityAdverseReactionResult);


        Future<Boolean> guideDrugSituationResult = gptAnalysisThreadPool.submit(() -> {
            long begin_guideDrugSituation = System.currentTimeMillis();
            JSONObject guideDrugSituation = new JSONObject();
//            try {
//                guideDrugSituation = this.guideDrugSituation(drugName, enterpriseName, drugInfo);
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (guideDrugSituation.getString("score") == null) {
//                    guideDrugSituation.put("score", 0);
//                }
//                if (guideDrugSituation.getString("process") == null) {
//                    guideDrugSituation.put("process", "");
//                }
//            }
//            log.info("guideDrugSituation  gpt  分析时长{}", System.currentTimeMillis() - begin_guideDrugSituation);
            String originalDrug = drugInfo.getOriginalDrug();
            String referenceDrug = drugInfo.getReferenceDrug();
            String consistencyDrug = drugInfo.getConsistencyDrug();
            if (CommonConstants.YES.equals(originalDrug)) {
                guideDrugSituation.put("process", "本药品为原研药品");
                guideDrugSituation.put("score", 1);
            }
            if (!CommonConstants.YES.equals(originalDrug) && "本品为仿制药参比药品。".equals(referenceDrug)) {
                guideDrugSituation.put("process", "本药品为仿制药参比药品");
                guideDrugSituation.put("score", 1);
            }
            if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && CommonConstants.YES.equals(consistencyDrug)) {
                guideDrugSituation.put("process", "本药品为一致性评价药品");
                guideDrugSituation.put("score", 0.5);
            }
            if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && !CommonConstants.YES.equals(consistencyDrug)) {
                guideDrugSituation.put("process", "本药品为非一致性评价药品");
                guideDrugSituation.put("score", 0);
            }
            gptAnalysisMap.put("guideDrugSituation", guideDrugSituation);
            return true;
        });
        futureResult.put("guideDrugSituation", guideDrugSituationResult);

        Future<Boolean> guideEnterpriseResult = gptAnalysisThreadPool.submit(() -> {
            // 生产企业情况
            long begin_guideEnterprise = System.currentTimeMillis();
            JSONObject guideEnterprise = new JSONObject();
            try {
                guideEnterprise = this.guideEnterprise(enterpriseName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideEnterprise.getString("score") == null) {
                    guideEnterprise.put("score", 0);
                }
                if (guideEnterprise.getString("process") == null) {
                    guideEnterprise.put("process", "");
                }
            }
            log.info("guideEnterprise  gpt  分析时长{}", System.currentTimeMillis() - begin_guideEnterprise);

            gptAnalysisMap.put("guideEnterprise", guideEnterprise);
            return true;
        });
        futureResult.put("guideEnterprise", guideEnterpriseResult);

        Future<Boolean> guideCountryResult = gptAnalysisThreadPool.submit(() -> {
            long begin_guideCountry = System.currentTimeMillis();
            JSONObject guideCountry = new JSONObject();
            try {
                guideCountry = this.guideCountry(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideCountry.getString("score") == null) {
                    guideCountry.put("score", 0);
                }
                if (guideCountry.getString("process") == null) {
                    guideCountry.put("process", "");
                }
                String process_country = guideCountry.getString("process");
                process_country = process_country.replaceFirst("\\{", "");
                process_country = process_country.replaceFirst("\\}", "");
                guideCountry.put("process", process_country);

            }
            log.info("guideCountry  gpt  分析时长{}", System.currentTimeMillis() - begin_guideCountry);

            gptAnalysisMap.put("guideCountry", guideCountry);
            return true;
        });
        futureResult.put("guideCountry", guideCountryResult);


    }


    private JSONObject extractMaxPercentageGpt(DrugInfoNew drugInfo) {
        JSONObject jsonObject = new JSONObject();
        ArrayList<String> strings = new ArrayList<>();
        strings.add(drugInfo.getDrugZh());
        strings.addAll(drugInfo.getDrugSynonymZh());
        jsonObject.put("drugSynonym", strings);
        ArrayList<String> strings1 = new ArrayList<>();
        strings1.add("不良反应");
        jsonObject.put("diseaseSynonym", strings1);
        jsonObject.put("title", drugInfo.getDrugZh() + "的不良反应");
        List<String> s = evidenceFeign.vectorRetrieval(jsonObject);
        if (s.size() == 0) {
            return null;
        }
        IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
        idsQueryBuilder.addIds(s.toArray(new String[0]));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQueryBuilder().withQuery(idsQueryBuilder).build();
        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        if (literatureSearchHits.getTotalHits() == 0) {
            return null;
        } else {
            String prompt = "请作为一名专业的PV（药物警戒专员），专门研究药物的不良反应。请根据以下文献原文，汇总并分析不同文献中描述的" + drugInfo.getDrugZh() + "的中度不良反应以及重度不良反应分别有哪些（尽量选取不一样的中度不良反应与重度不良反应名称），需要给出不良反应的名称以及发生率。并结合以下评分规则分别对中度不良反应及重度不良反应进行打分：\n" +
                    "中度不良反应评分规则（单选，得分不相加，只计算最高发生率的得分）：\n" +
                    "发生率<1%，3分\n" +
                    "发生率 1%~10%：2分\n" +
                    "发生率>10%：1分\n" +
                    "未提供 ADR 发生数据：0分\n" +
                    "重度不良反应评分规则（单选，得分不相加，只计算最高发生率的得分）：\n" +
                    "发生率<0.01%：5分\n" +
                    "发生率 0.01%~0.1%：4分\n" +
                    "发生率 0.1%~1%：3分\n" +
                    "发生率 1%~10%：2分\n" +
                    "发生率>10%：1分\n" +
                    "未提供 ADR 发生数据：0分\n" +
                    "请注意：\n" +
                    "如果文献中提到了样本量，以及发生相应不良反应的病例数，需要根据这两者信息计算发生率。\n" +
                    "严重药品不良反应的判定标准包括以下几种情况：\n" +
                    "导致患者死亡；\n" +
                    "危及惠者生命；\n" +
                    "导致患者住院或延长住院时间；\n" +
                    "造成永久或显著的残疾/功能丧失；\n" +
                    "引起先天性异常/出生缺陷；\n" +
                    "导致其他重要医学事件，如不进行治疗可能出现上述所列情况" +
                    "文献如下（分别考虑所有给出的文献，优先使用有发生率的文献）：";
            ;
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                Literature literature = literatureSearchHit.getContent();
                prompt += "\n标题：" + literature.getTitle() + "\n摘要：" + literature.getSummary() + "\n";
            }
            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("content1", "中度不良反应以及其发生率");
            stringStringHashMap.put("score1", "中度不良反应得分(类型是int类型的阿拉伯数字，返回一个阿拉伯数字即可)");
            stringStringHashMap.put("content2", "重度不良反应以及其发生率");
            stringStringHashMap.put("score2", "重度不良反应得分(类型是int类型的阿拉伯数字，返回一个阿拉伯数字即可)");
            JSONObject responseFormat = getResponseFormat(stringStringHashMap);
            JSONObject jsonObject1 = executeGptPlus(prompt, "中度不良反应以及重度不良反应", responseFormat, "","5,4,3,2,1,0");
            return jsonObject1;


        }

    }

    private double extractMaxPercentage(String text) {

        // 提取所有的百分比值
        Pattern pattern = Pattern.compile("(\\d+(\\.\\d+)?)[%％]");
        Matcher matcher = pattern.matcher(text);
        String regex1 = "1\\/([\\d,]+)";
        Pattern pattern1 = Pattern.compile(regex1);
        Matcher matcher1 = pattern1.matcher(text);
        double maxPercentage = 0.0;

        while (matcher1.find()) {
            String fractionStr = matcher1.group(0); // 完整的匹配项，例如 "1/10,000"
            String denominatorStr = matcher1.group(1).replace(",", ""); // 分母部分，例如 "10000"

            BigDecimal denominator = new BigDecimal(denominatorStr);
            BigDecimal rate = new BigDecimal("1").divide(denominator, 10, BigDecimal.ROUND_HALF_UP);
            BigDecimal percentage1 = rate.multiply(new BigDecimal("100"));
            double v = percentage1.doubleValue();
            v += 0.001;
            if (v > maxPercentage) {
                maxPercentage = v;
            }

        }


        while (matcher.find()) {
            double percentage = Double.parseDouble(matcher.group(1));
            if (percentage > maxPercentage) {
                maxPercentage = percentage;
            }
        }

        if (maxPercentage == 0.0) {
            return 0;
        }
        if (maxPercentage >= 10) {
            return 1;
        } else if (maxPercentage >= 1 && maxPercentage < 10) {
            return 2;
        } else if (maxPercentage <= 1) {
            return 3;
        } else {
            return 0;
        }

    }

    private double extractMaxPercentage1(String text) {
        String regex1 = "1\\/([\\d,]+)";
        Pattern pattern1 = Pattern.compile(regex1);
        Matcher matcher1 = pattern1.matcher(text);
        double maxPercentage = 0.0;

        while (matcher1.find()) {
            String fractionStr = matcher1.group(0); // 完整的匹配项，例如 "1/10,000"
            String denominatorStr = matcher1.group(1).replace(",", ""); // 分母部分，例如 "10000"

            BigDecimal denominator = new BigDecimal(denominatorStr);
            BigDecimal rate = new BigDecimal("1").divide(denominator, 10, BigDecimal.ROUND_HALF_UP);
            BigDecimal percentage1 = rate.multiply(new BigDecimal("100"));
            double v = percentage1.doubleValue();
            v += 0.001;
            if (v > maxPercentage) {
                maxPercentage = v;
            }

        }


        // 提取所有的百分比值
        Pattern pattern = Pattern.compile("(\\d+(\\.\\d+)?)[%％]");
        Matcher matcher = pattern.matcher(text);
        while (matcher.find()) {
            double percentage = Double.parseDouble(matcher.group(1));
            if (percentage > maxPercentage) {
                maxPercentage = percentage;
            }
        }

        if (maxPercentage == 0.0) {
            return 0;
        }

        if (maxPercentage >= 10) {
            return 1;
        } else if (maxPercentage >= 1 && maxPercentage < 10) {
            return 2;
        } else if (maxPercentage >= 0.1 && maxPercentage < 1) {
            return 3;
        } else if (maxPercentage >= 0.01 && maxPercentage < 0.1) {
            return 4;
        } else if (maxPercentage > 0 && maxPercentage < 0.01) {
            return 5;
        } else {
            return 0;
        }
    }


    private void useThreadPoolExecutePromptPc(String drugName, String disease, DrugInfoNew drugInfo,
                                              String enterpriseName, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap,
                                              List<GuideDto> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                              Map<Literature, JSONObject> literatureMap, DrugAddDto drugAdd, List<String> drugs, List<String> diseases) {
        Future<Boolean> indicationResult = gptAnalysisThreadPool.submit(() -> {
            // 2.1 适应症
            long begin_indication = System.currentTimeMillis();
            JSONObject indication = new JSONObject();
            try {
                indication = this.indicationPc(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (indication.getString("score") == null) {
                    indication.put("score", 0);
                }
                if (indication.getString("process") == null) {
                    indication.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getIndicationx())) {
                    indication.put("process", drugInfo.getIndicationx());
                }
            }
            log.info("indication  gpt  分析时长{}", System.currentTimeMillis() - begin_indication);

            gptAnalysisMap.put("indication", indication);
            return true;
        });
        futureResult.put("indication", indicationResult);


        Future<Boolean> clinicalResult = gptAnalysisThreadPool.submit(() -> {
            // 2.3 临床疗效
            long begin_clinical = System.currentTimeMillis();
            JSONObject clinical = new JSONObject();
            try {
                clinical = this.clinicalPc(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (clinical.getString("score") == null) {
                    clinical.put("score", 0);
                }
                if (clinical.getString("process") == null) {
                    clinical.put("process", "");
                }

                if (StringUtils.isNotEmpty(drugInfo.getClinical())) {
                    clinical.put("process", drugInfo.getClinical());
                }
            }
            log.info("clinical  gpt  分析时长{}", System.currentTimeMillis() - begin_clinical);

            gptAnalysisMap.put("clinical", clinical);
            return true;
        });
        futureResult.put("clinical", clinicalResult);

        Future<Boolean> adverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.1 重度和中度不良反应
            long begin_adverseReaction = System.currentTimeMillis();
            JSONObject adverseReaction = new JSONObject();
            try {
                JSONObject jsonObject = this.commonAdverseReaction(drugName, disease, drugInfo);
                JSONObject jsonObject1 = this.seriousAdverseReaction(drugName, disease, drugInfo);
                adverseReaction.put("severeAdverseReaction", jsonObject1.getString("severeAdverseReaction"));
                adverseReaction.put("mildAdverseReaction", jsonObject.getString("mildAdverseReaction"));
                adverseReaction.put("mildAdverseReactionScore", jsonObject.getString("mildAdverseReactionScore"));
                adverseReaction.put("severeAdverseReactionScore", jsonObject1.getString("severeAdverseReactionScore"));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (adverseReaction.getString("severeAdverseReaction") == null) {
                    adverseReaction.put("severeAdverseReaction", "暂无相关内容");
                }
                if (adverseReaction.getString("mildAdverseReaction") == null) {
                    adverseReaction.put("mildAdverseReaction", "暂无相关内容");
                }
                String severeAdverseReaction = adverseReaction.getString("severeAdverseReaction");
                severeAdverseReaction = severeAdverseReaction.replaceFirst("\\[", "");
                severeAdverseReaction = severeAdverseReaction.replaceFirst("\\]", "");
                adverseReaction.put("severeAdverseReaction", severeAdverseReaction);

                if (adverseReaction.getString("mildAdverseReaction") == null) {
                    adverseReaction.put("mildAdverseReaction", "");
                }
                String mildAdverseReaction = adverseReaction.getString("mildAdverseReaction");
                mildAdverseReaction = mildAdverseReaction.replaceFirst("\\[", "");
                mildAdverseReaction = mildAdverseReaction.replaceFirst("\\]", "");
                adverseReaction.put("mildAdverseReaction", mildAdverseReaction);

                boolean mildAdverseReactionScore = false;
                boolean severeAdverseReactionScore = false;
                if (StringUtils.isNotEmpty(drugInfo.getCommonAdverseReactions())) {
                    double v = extractMaxPercentage(drugInfo.getCommonAdverseReactions());
                    if (v > 0) {
                        mildAdverseReactionScore = true;
                    }
                    adverseReaction.put("mildAdverseReaction", drugInfo.getCommonAdverseReactions());
                    adverseReaction.put("mildAdverseReactionScore", v);
                }
                if (StringUtils.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
                    double v = extractMaxPercentage1(drugInfo.getSeriousAdverseRactions());
                    if (v > 0) {
                        severeAdverseReactionScore = true;
                    }
                    adverseReaction.put("severeAdverseReaction", drugInfo.getSeriousAdverseRactions());
                    adverseReaction.put("severeAdverseReactionScore", v);
                }
//                if (!mildAdverseReactionScore||!severeAdverseReactionScore){
//                    JSONObject jsonObject = extractMaxPercentageGpt(drugInfo);
//                    if (!mildAdverseReactionScore&&ObjectUtil.isNotEmpty(jsonObject)){
//                        adverseReaction.put("mildAdverseReaction", jsonObject.getString("content1"));
//                        adverseReaction.put("mildAdverseReactionScore", jsonObject.getString("score1"));
//                    }
//                    if (!severeAdverseReactionScore&&ObjectUtil.isNotEmpty(jsonObject)){
//                        adverseReaction.put("severeAdverseReaction", jsonObject.getString("content2"));
//                        adverseReaction.put("severeAdverseReactionScore", jsonObject.getString("score2"));
//                    }
//
//                }
            }

            gptAnalysisMap.put("adverseReaction", adverseReaction);
            log.info("adverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_adverseReaction);
            return true;
        });
        futureResult.put("adverseReaction", adverseReactionResult);
//        Future<Boolean> literatureResult = gptAnalysisThreadPool.submit(() -> {
//            List<Literature> literatureList = queryLiterature(drugName, drugs, disease, diseases);
//            if (literatureList.size() >= 2) {
//                literatureList = literatureList.subList(0, 2);
//            }
//
//            for (int i = 0; i < literatureList.size(); i++) {
//                int trail = i + 1;
//                Literature literature = literatureList.get(i);
//                Future<Boolean> literatureResult_trail = gptAnalysisThreadPool.submit(() -> {
//                    long begin_literature = System.currentTimeMillis();
//                    JSONObject guide = new JSONObject();
//                    try {
//                        String summary = literature.getSummary();
//                        String title = literature.getTitle();
//                        guide = this.literature(drugName, disease, summary, title, drugInfo);
//                    } catch (Exception e) {
//                        log.error(e.getMessage(), e);
//                    } finally {
//                        if (guide.getString("score") == null) {
//                            guide.put("score", 0);
//                        }
//                        if (guide.getString("process") == null) {
//                            guide.put("process", "");
//                        }
//                    }
//                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_literature);
//
//                    literatureMap.put(literature, guide);
//                    return true;
//                });
//                futureResult.put("literature_" + trail, literatureResult_trail);
//            }
//            return true;
//        });
//        futureResult.put("literatureResult", literatureResult);


        Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {

            List<GuidelinesVo> guidelinesVo = drugInfo.getGuidelinesVo();


            for (int i = 0; i < guidelinesVo.size(); i++) {
                int trail = i + 1;
                GuidelinesVo guideVO = guidelinesVo.get(i);
                GuideDto guideDto = new GuideDto();
                guideDto.setGuidelines(guideVO);
                guideEffectiveMap.add(guideDto);
                Future<Boolean> guideResult_trail = gptAnalysisThreadPool.submit(() -> {
                    long begin_guide = System.currentTimeMillis();
                    JSONObject guide = new JSONObject();
                    try {
                        String title = guideVO.getShowField();
                        guide = this.guidePc(drugName, disease, title, guideVO.getContent(), drugInfo);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guide.getString("score") == null) {
                            guide.put("score", 0);
                        }
                        if (guide.getString("process") == null) {
                            guide.put("process", "");
                        }
                        guideDto.setGuide(guide);
                    }
                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);


                    return true;
                });
                futureResult.put("mainGuide_" + trail, guideResult_trail);
            }
            return true;
        });
        futureResult.put("guideResult", guideResult);


        Future<Boolean> specialCrowd_pregnantWomenResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-孕妇及哺乳期妇女
            long begin_specialCrowd_pregnantWomen = System.currentTimeMillis();
            JSONObject specialCrowd_pregnantWomen = new JSONObject();
            try {
                specialCrowd_pregnantWomen = this.specialCrowd_pregnantWomen(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_pregnantWomen.getString("pregnantScore") == null) {
                    specialCrowd_pregnantWomen.put("pregnantScore", 0);
                }
                if (specialCrowd_pregnantWomen.getString("lactatingScore") == null) {
                    specialCrowd_pregnantWomen.put("lactatingScore", 0);
                }
                if (specialCrowd_pregnantWomen.getString("process") == null) {
                    specialCrowd_pregnantWomen.put("process", "");
                }
            }
            log.info("specialCrowd_pregnantWomen  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen);
            gptAnalysisMap.put("specialCrowd_pregnantWomen", specialCrowd_pregnantWomen);
            return true;
        });
        futureResult.put("specialCrowd_pregnantWomen", specialCrowd_pregnantWomenResult);


        Future<Boolean> specialCrowd_childrenMedicineResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-儿童
            long begin_specialCrowd_childrenMedicine = System.currentTimeMillis();
            JSONObject specialCrowd_childrenMedicine = new JSONObject();
            try {
                specialCrowd_childrenMedicine = this.specialCrowd_childrenMedicine(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_childrenMedicine.getString("score") == null) {
                    specialCrowd_childrenMedicine.put("score", 0);
                }
                if (specialCrowd_childrenMedicine.getString("process") == null) {
                    specialCrowd_childrenMedicine.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getChildrenMedicine())) {
                    specialCrowd_childrenMedicine.put("process", drugInfo.getChildrenMedicine());
                }
            }
            log.info("specialCrowd_childrenMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_childrenMedicine);

            gptAnalysisMap.put("specialCrowd_childrenMedicine", specialCrowd_childrenMedicine);
            return true;
        });
        futureResult.put("specialCrowd_childrenMedicine", specialCrowd_childrenMedicineResult);


        Future<Boolean> specialCrowd_geriatricMedicineResult = gptAnalysisThreadPool.submit(() -> {
            // 3.3 特殊人群-老年
            long begin_specialCrowd_geriatricMedicine = System.currentTimeMillis();
            JSONObject specialCrowd_geriatricMedicine = new JSONObject();
            try {
                specialCrowd_geriatricMedicine = this.specialCrowd_geriatricMedicine(drugName, disease, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_geriatricMedicine.getString("score") == null) {
                    specialCrowd_geriatricMedicine.put("score", 0);
                }
                if (specialCrowd_geriatricMedicine.getString("process") == null) {
                    specialCrowd_geriatricMedicine.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getGeriatricMedicine())) {
                    specialCrowd_geriatricMedicine.put("process", drugInfo.getGeriatricMedicine());
                }
            }
            log.info("specialCrowd_geriatricMedicine  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_geriatricMedicine);

            gptAnalysisMap.put("specialCrowd_geriatricMedicine", specialCrowd_geriatricMedicine);
            return true;
        });
        futureResult.put("specialCrowd_geriatricMedicine", specialCrowd_geriatricMedicineResult);


        Future<Boolean> specialCrowd_liverKidneyResult = gptAnalysisThreadPool.submit(() -> {
            // 3.2 特殊人群-肝肾功能异常者
            long begin_specialCrowd_liverKidney = System.currentTimeMillis();
            JSONObject specialCrowd_liverKidney = new JSONObject();
            JSONObject specialCrowd_liver = new JSONObject();
            JSONObject specialCrowd_Kidney = new JSONObject();
            try {
                specialCrowd_liver = specialCrowd_liver(drugName, disease, drugInfo);
                specialCrowd_Kidney = specialCrowd_Kidney(drugName, disease, drugInfo);

            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {


                if (specialCrowd_liver.getString("liverScore") == null) {
                    specialCrowd_liver.put("liverScore", 0);
                }
                if (specialCrowd_Kidney.getString("kidneyScore") == null) {
                    specialCrowd_Kidney.put("kidneyScore", 0);
                }

                if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency()) && StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    specialCrowd_liverKidney.put("liverScore", 3);
                    specialCrowd_liverKidney.put("kidneyScore", 3);
                    specialCrowd_liverKidney.put("process", "未找到肝、肾功能不全者剂量调整信息。");
                } else {

                    if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                        specialCrowd_liverKidney.put("liverScore", 3);
                        specialCrowd_liverKidney.put("kidneyScore", specialCrowd_Kidney.getString("kidneyScore"));
                        specialCrowd_liverKidney.put("process", "未找到肝功能不全者剂量调整信息。\n" + drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                    } else if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                        specialCrowd_liverKidney.put("kidneyScore", 3);
                        specialCrowd_liverKidney.put("liverScore", specialCrowd_liver.getString("liverScore"));
                        specialCrowd_liverKidney.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() + "\n未找到肾功能不全者剂量调整信息。");
                    } else {
                        specialCrowd_liverKidney.put("liverScore", specialCrowd_liver.getString("liverScore"));
                        specialCrowd_liverKidney.put("kidneyScore", specialCrowd_Kidney.getString("kidneyScore"));
                        specialCrowd_liverKidney.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction() + "\n" + drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                    }
                }
            }
            log.info("specialCrowd_liverKidney  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liverKidney);

            gptAnalysisMap.put("specialCrowd_liverKidney", specialCrowd_liverKidney);
            return true;
        });
        futureResult.put("specialCrowd_liverKidney", specialCrowd_liverKidneyResult);


        Future<Boolean> drugInteractionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.3 药物相互作用
            long begin_drugInteraction = System.currentTimeMillis();
            JSONObject drugInteraction = new JSONObject();
            try {
                drugInteraction = this.drugInteraction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (drugInteraction.getString("score") == null) {
                    drugInteraction.put("score", 0);
                }
                if (drugInteraction.getString("process") == null) {
                    drugInteraction.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getDrugInteraction())) {
                    drugInteraction.put("process", drugInfo.getDrugInteraction());
                }
            }
            log.info("drugInteraction  gpt  分析时长{}", System.currentTimeMillis() - begin_drugInteraction);

            gptAnalysisMap.put("drugInteraction", drugInteraction);
            return true;
        });
        futureResult.put("drugInteraction", drugInteractionResult);


        Future<Boolean> otherAdverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.4 其他不良反应
            long begin_otherAdverseReaction = System.currentTimeMillis();
            JSONObject otherAdverseReaction = new JSONObject();
            try {
                otherAdverseReaction = this.otherAdverseReaction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (otherAdverseReaction.getString("score") == null) {
                    otherAdverseReaction.put("score", 0);
                }
                if (otherAdverseReaction.getString("process") == null) {
                    otherAdverseReaction.put("process", "");
                }
                String process = otherAdverseReaction.getString("process");
                process = process.replaceFirst("\\{", "");
                process = process.replaceFirst("\\}", "");
                otherAdverseReaction.put("process", process);
            }
            log.info("otherAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_otherAdverseReaction);

            gptAnalysisMap.put("otherAdverseReaction", otherAdverseReaction);
            return true;
        });
        futureResult.put("otherAdverseReaction", otherAdverseReactionResult);


        Future<Boolean> genicityAdverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            // 3.4 其他不良反应
            long begin_genicityAdverseReaction = System.currentTimeMillis();
            JSONObject genicityAdverseReaction = new JSONObject();
            try {
                genicityAdverseReaction = this.genicityAdverseReaction(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (genicityAdverseReaction.getString("score") == null) {
                    genicityAdverseReaction.put("score", 0);
                }
                if (genicityAdverseReaction.getString("process") == null) {
                    genicityAdverseReaction.put("process", "");
                }
                String process = genicityAdverseReaction.getString("process");
                process = process.replaceFirst("\\{", "");
                process = process.replaceFirst("\\}", "");
                genicityAdverseReaction.put("process", process);

                if (StringUtils.isNotEmpty(drugInfo.getGeneticsReproductionCarcinogenicity()) || StringUtils.isNotEmpty(drugInfo.getPoison())) {
                    process = StringUtils.isNotEmpty(drugInfo.getGeneticsReproductionCarcinogenicity()) ? drugInfo.getGeneticsReproductionCarcinogenicity() : drugInfo.getPoison();
                    genicityAdverseReaction.put("process", process);
                } else {
                    genicityAdverseReaction.put("process", "未发现致癌性与致畸性");
                    genicityAdverseReaction.put("score", 1);
                }
            }
            log.info("genicityAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_genicityAdverseReaction);

            gptAnalysisMap.put("genicityAdverseReaction", genicityAdverseReaction);
            return true;
        });
        futureResult.put("genicityAdverseReaction", genicityAdverseReactionResult);


        Future<Boolean> guideDrugSituationResult = gptAnalysisThreadPool.submit(() -> {
            long begin_guideDrugSituation = System.currentTimeMillis();
            JSONObject guideDrugSituation = new JSONObject();
//            try {
//                guideDrugSituation = this.guideDrugSituation(drugName, enterpriseName, drugInfo);
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (guideDrugSituation.getString("score") == null) {
//                    guideDrugSituation.put("score", 0);
//                }
//                if (guideDrugSituation.getString("process") == null) {
//                    guideDrugSituation.put("process", "");
//                }
//            }
//            log.info("guideDrugSituation  gpt  分析时长{}", System.currentTimeMillis() - begin_guideDrugSituation);
            String originalDrug = drugInfo.getOriginalDrug();
            String referenceDrug = drugInfo.getReferenceDrug();
            String consistencyDrug = drugInfo.getConsistencyDrug();
            if (CommonConstants.YES.equals(originalDrug)) {
                String s = "本药品为原研药品";
                if (StringUtils.isNotEmpty(referenceDrug) && "本品为仿制药参比药品。".equals(referenceDrug)) {
                    s = s + "       " + referenceDrug;
                }
                guideDrugSituation.put("process", s);
                guideDrugSituation.put("score", 1);
            }

            if (!CommonConstants.YES.equals(originalDrug) && "本品为仿制药参比药品。".equals(referenceDrug)) {
                guideDrugSituation.put("process", "本药品为仿制药参比药品");
                guideDrugSituation.put("score", 1);
            }
            if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && CommonConstants.YES.equals(consistencyDrug)) {
                guideDrugSituation.put("process", "本药品为一致性评价药品");
                guideDrugSituation.put("score", 0.5);
            }
            if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && !CommonConstants.YES.equals(consistencyDrug)) {
                guideDrugSituation.put("process", "本药品为非一致性评价药品");
                guideDrugSituation.put("score", 0);
            }
            gptAnalysisMap.put("guideDrugSituation", guideDrugSituation);
            return true;
        });
        futureResult.put("guideDrugSituation", guideDrugSituationResult);

        Future<Boolean> guideEnterpriseResult = gptAnalysisThreadPool.submit(() -> {
            // 生产企业情况
            long begin_guideEnterprise = System.currentTimeMillis();
            JSONObject guideEnterprise = new JSONObject();
            try {
                guideEnterprise = this.guideEnterprise(enterpriseName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideEnterprise.getString("score") == null) {
                    guideEnterprise.put("score", 0);
                }
                if (guideEnterprise.getString("process") == null) {
                    guideEnterprise.put("process", "");
                }
            }
            log.info("guideEnterprise  gpt  分析时长{}", System.currentTimeMillis() - begin_guideEnterprise);

            gptAnalysisMap.put("guideEnterprise", guideEnterprise);
            return true;
        });
        futureResult.put("guideEnterprise", guideEnterpriseResult);

        Future<Boolean> guideCountryResult = gptAnalysisThreadPool.submit(() -> {
            long begin_guideCountry = System.currentTimeMillis();
            JSONObject guideCountry = new JSONObject();
            try {
                guideCountry = this.guideCountry(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideCountry.getString("score") == null) {
                    guideCountry.put("score", 0);
                }
                if (guideCountry.getString("process") == null) {
                    guideCountry.put("process", "");
                }
                String process_country = guideCountry.getString("process");
                process_country = process_country.replaceFirst("\\{", "");
                process_country = process_country.replaceFirst("\\}", "");
                guideCountry.put("process", process_country);

            }
            log.info("guideCountry  gpt  分析时长{}", System.currentTimeMillis() - begin_guideCountry);

            gptAnalysisMap.put("guideCountry", guideCountry);
            return true;
        });
        futureResult.put("guideCountry", guideCountryResult);


    }

    private int otherAnalysis(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String enterpriseName, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<String> stringBuilder) {
        // 5.其他属性部分
        addProcess(id, step++, "<b>5、其他属性</b>", stringBuilder);
        addProcess(id, step++, "考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。", stringBuilder);

        float otherVscore = 0f;
        // 5.1 国家医保纳入情况模块
        // 是否在医保目录
        // boolean isInsurance = this.mongoTemplate.exists(new Query(Criteria.where("registered_name").is(drugName).and("medicine_enterprise").is(enterpirceName)),JSONObject.class,"medical_insurance_drugs");
        boolean isInsurance = false;
        String medicalInsurance = drugInfo1.getMedicalInsurance();
        if (StringUtils.isNotBlank(medicalInsurance)) {
            isInsurance = true;
        }
        addProcess(id, step++, "（1）国家医保纳入情况：", stringBuilder);
        addProcess(id, step++, isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? "，" + drugInfo1.getMedicalInsurance() : "") : "未纳入医保", stringBuilder);

        // 医保得分
        float isInsuranceScore = 1.00F;
        if (isInsurance) {
            boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo1.getPaymentScope());
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
        otherVscore = isInsuranceScore;

        // 5.2 国家基本药物目录纳入情况模块
        // 是否基本药物
        // boolean isBase = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("essentialMedicines").is("是")),DrugAndPrice.class);
        boolean isBase = false;
        String essentialMedicines = drugInfo1.getEssentialMedicines();
        if ("是".equals(essentialMedicines)) {
            isBase = true;
        }
        addProcess(id, step++, "（2）国家基本药物目录纳入情况：", stringBuilder);
        addProcess(id, step++, isBase ? "已被纳入国家基本药物目录" : "未纳入国家基本药物目录", stringBuilder);
        int typeScore = 0;
        String essentialType = drugInfo1.getEssentialType();
        if (StringUtils.isNotBlank(essentialType)) {
            typeScore = 1;
        }
        otherVscore = isBase ? otherVscore + 3 - typeScore : otherVscore + 1;

        // 5.3 国家集中采购情况模块
        // 是否集中采购
        // boolean isConcentrate = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("enterprise").is(enterpirceName)),JSONObject.class,"country_concentrate_drugs");
        boolean isConcentrate = true;
        String drugCollection = drugInfo1.getDrugCollection();
        if ("本品非集采药品。".equals(drugCollection) || drugCollection.contains("不属于")) {
            isConcentrate = false;
        }
        addProcess(id, step++, "（3）国家集中采购情况：", stringBuilder);
        addProcess(id, step++, isConcentrate ? "已纳入国家集中采购" : "未纳入国家集中采购", stringBuilder);
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

        addProcess(id, step++, "（4）药品情况：", stringBuilder);
        String process = "";
        try {
            process = guideDrugSituation.getString("process");
            otherVscore += guideDrugSituation.getFloat("score");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        if (StringUtils.isNotBlank(process)) {
            addProcess(id, step++, formatInfo(process), stringBuilder);
            drugSituationString = process;
        } else {
            addProcess(id, step++, "未知", stringBuilder);
        }


        // 5.5 生产企业情况模块
        String enterpriseString = "未知";
        // 生产企业情况
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

        addProcess(id, step++, "（5）生产企业状况：", stringBuilder);
        String process_enterprise = "";
        try {
            process_enterprise = StringUtils.isNotBlank(drugInfo1.getManufacturers()) ? drugInfo1.getManufacturers() : guideEnterprise.getString("process");
            otherVscore += guideEnterprise.getFloat("score");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        if (StringUtils.isNotBlank(process)) {
            addProcess(id, step++, formatInfo(process_enterprise), stringBuilder);
            enterpriseString = process_enterprise;
        } else {
            addProcess(id, step++, "未知", stringBuilder);
        }


        // 5.6 全球使用情况模块
        // 全球使用情况
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

        addProcess(id, step++, "（6）全球使用情况：", stringBuilder);
        String process_country = "";
        try {
            otherVscore += guideCountry.getFloat("score");
            process_country = StringUtils.isNotBlank(drugInfo1.getGlobalUsage()) ? drugInfo1.getGlobalUsage() : guideCountry.getString("process");
        } catch (Exception e) {
            otherVscore += 0;
            log.error(e.getMessage(), e);
        }

        if (StringUtils.isNotBlank(process_country)) {
            addProcess(id, step++, formatInfo(process_country), stringBuilder);
            countryString = process_country;
        } else {
            addProcess(id, step++, "未知", stringBuilder);
        }

        // 第六部分 药品综合评价之其他属性
        JSONObject otherAttributes = new JSONObject();
        result.put("otherAttributes", otherAttributes);
        String otherFormatScore = formatScore(new BigDecimal(otherVscore).setScale(2, RoundingMode.HALF_UP).toString());
        otherAttributes.put("score", "其他属性得分：" + formatScore(otherFormatScore) + "分");
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
        // 支付限制
        otherAttributes.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
        otherAttributes.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其他属性进行评价：总分10分，考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。");
        // 是否列为国家集中采购药品
        otherAttributes.put("procurementOfDrugs", isConcentrate);
        // 国家基本药物得分
        otherAttributes.put("essentialMedicinesScore", isBase ? 3 - typeScore : 1);
        // 有无△要求
        otherAttributes.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
        // 国家医保目录得分
        otherAttributes.put("reimbursementListScore", formatScore(String.valueOf(isInsuranceScore)));
        // 国家集中采购药品得分
        otherAttributes.put("procurementOfDrugsScore", isConcentrate ? 1 : 0);
        // 原研/参比/一致性评价
        otherAttributes.put("guideDrugSituation", drugSituationString);
        try {
            otherAttributes.put("guideDrugSituationScore", formatScore(String.valueOf(guideDrugSituation.getFloat("score"))));
        } catch (Exception e) {
            otherAttributes.put("guideDrugSituationScore", 0);
            log.error(e.getMessage(), e);
        }
        // 生产企业状态
        otherAttributes.put("guideEnterprise", enterpriseString);
        try {
            otherAttributes.put("guideEnterpriseScore", StringUtils.isNotEmpty(process_enterprise) ? formatScore(String.valueOf(guideEnterprise.getFloat("score"))) : 0);
        } catch (Exception e) {
            otherAttributes.put("guideEnterpriseScore", 0);
            log.error(e.getMessage(), e);
        }
        // 全球使用情况
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
                log.error(e.getMessage(), e);
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
            jsonObject5.put("value", result.getJSONObject("economical").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        return step;
    }


    /**
     * app端经济性   9/29修改与pc不同    priceId来路也不同
     *
     * @param drugName
     * @param disease
     * @param drugInfo1
     * @param step
     * @param id
     * @param result
     * @param priceId
     * @param enterpriseName
     * @param stringBuilder
     * @return
     */
    private int economicalAnalysisApp(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String priceId, String enterpriseName, List<String> stringBuilder) {
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
            addProcessCache(id, step++, "<b>4、经济性</b>", stringBuilder, CacheNameEnum.ECONOMY_TITLE);
            addProcessCache(id, step++, "考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。根据您输入的内容，系统为您计算该药品在经济性上的评分结果为" + economicalFormatScore + "分。",
                    stringBuilder, CacheNameEnum.ECONOMY);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return step;
    }

    private void addProcessCache(String id, int step, String msg, List<String> stringBuilder, CacheNameEnum cacheName) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(cacheName.getName());
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    private int economicalAnalysis(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String priceId, String enterpriseName, List<String> stringBuilder) {
        JSONObject economical = new JSONObject();
        result.put("economical", economical);
        try {
            // 当前药品价格信息
//            SaveDrugPrice currDrugFee = this.mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId).and("drugName").is(drugName).and("manufacturer").is(enterpriseName)), SaveDrugPrice.class);

            BigDecimal economicalVScore = new BigDecimal(0);
            SaveDrugPrice2 saveDrugPrice = drugInfo1.getSaveDrugPrice();
            Double averageDailyCost = 0.0;
            Double replaceableCost = 0.0;
            Double alternativeMinAverageDailyCost = 0.0;
            economical.put("saveDrugPrice", saveDrugPrice);
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
            economical.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其经济性进行评价：总分10分，考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。");
            if (averageDailyCost != 0 && alternativeMinAverageDailyCost != 0) {
                try {
                    BigDecimal score = BigDecimal.valueOf(alternativeMinAverageDailyCost).divide(BigDecimal.valueOf(averageDailyCost), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, RoundingMode.HALF_UP);
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

            if (averageDailyCost != 0 && replaceableCost != 0) {
                try {
                    BigDecimal score = BigDecimal.valueOf(replaceableCost).divide(BigDecimal.valueOf(averageDailyCost), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, RoundingMode.HALF_UP);
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
            addProcess(id, step++, "<b>4、经济性</b>", stringBuilder);
            addProcess(id, step++, "考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。根据您输入的内容，系统为您计算该药品在经济性上的评分结果为" + economicalFormatScore + "分。", stringBuilder);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return step;
    }

    private int economicalAnalysisPc(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, String priceId, String enterpriseName, List<String> stringBuilder) {
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
            addProcess(id, step++, "<b>4、经济性</b>", stringBuilder);
            addProcess(id, step++, "考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。根据您输入的内容，系统为您计算该药品在经济性上的评分结果为" + economicalFormatScore + "分。", stringBuilder);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return step;
    }


    public static double extractLastNumberx(String score) {
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

    public static String formatNumber(float number) {

        Double score = 0.0;

        try {
            score = Double.parseDouble(String.valueOf(number));
        } catch (NumberFormatException e) {
            log.error("得分格式化异常", e);
            score = extractLastNumberx(score.toString());
            log.info("得分格式化异常纠正为{}", score);
        }


        if (score % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(score);
        } else {
            return new DecimalFormat("#.##").format(score);
        }
    }


    private int safetyAnalysis(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<String> stringBuilder) {
        // 3 安全性部分
        JSONObject safety = new JSONObject();
        safety.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其安全性进行评价：总分25分，主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
        safety.put("details", new JSONObject());
        safety.put("specialPopulationsScore", "");
        safety.put("table", new JSONArray().fluentAdd(Arrays.asList("序号", "评价条目", "相关内容", "得分")));

        addProcess(id, step++, "<b>3、安全性</b>", stringBuilder);
        addProcess(id, step++, "主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。", stringBuilder);

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

        addProcess(id, step++, "（1）不良反应：", stringBuilder);
        addProcess(id, step++, formatInfo("中度不良反应：" + adverseReaction.getString("mildAdverseReaction")), stringBuilder);
        addProcess(id, step++, formatInfo("重度不良反应：" + adverseReaction.getString("severeAdverseReaction")), stringBuilder);

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

        addProcess(id, step++, "（2）特殊人群：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPregnantWomen())) {
            addProcess(id, step++, formatInfo("孕妇及哺乳期妇女：" + drugInfo.getPregnantWomen()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("孕妇及哺乳期妇女：" + specialCrowd_pregnantWomen.getString("process")), stringBuilder);
        }

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

        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getChildrenMedicine())) {
            addProcess(id, step++, formatInfo("儿童：" + drugInfo.getChildrenMedicine()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("儿童：" + specialCrowd_childrenMedicine.getString("process")), stringBuilder);
        }


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

        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getGeriatricMedicine())) {
            addProcess(id, step++, formatInfo("老年：" + drugInfo.getGeriatricMedicine()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("老年：" + specialCrowd_geriatricMedicine.getString("process")), stringBuilder);
        }


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

        addProcess(id, step++, formatInfo("肝肾功能异常者：" + specialCrowd_liverKidney.getString("process")), stringBuilder);


//        // 3.3 药物相互作用
//        long begin_drugInteraction = System.currentTimeMillis();
//        JSONObject drugInteraction = new JSONObject();
//        try {
//            drugInteraction = this.drugInteraction(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (drugInteraction.getString("score") == null) {
//                drugInteraction.put("score", 0);
//            }
//            if (drugInteraction.getString("process") == null) {
//                drugInteraction.put("process", "");
//            }
//        }
//        log.info("drugInteraction  gpt  分析时长{}", System.currentTimeMillis() - begin_drugInteraction);

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

        addProcess(id, step++, "（3）药物相互作用所致不良反应：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getDrugInteraction())) {
//            addProcess(id,step++,formatInfo(drugInfo.getDrugInteraction()));
//        } else {
//            addProcess(id,step++,formatInfo(drugInteraction.getString("process")));
//        }
        addProcess(id, step++, formatInfo(drugInteraction.getString("process")), stringBuilder);


//        // 3.4 其他不良反应
//        long begin_otherAdverseReaction = System.currentTimeMillis();
//        JSONObject otherAdverseReaction = new JSONObject();
//        try {
//            otherAdverseReaction = this.otherAdverseReaction(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (otherAdverseReaction.getString("score") == null) {
//                otherAdverseReaction.put("score", 0);
//            }
//            if (otherAdverseReaction.getString("process") == null) {
//                otherAdverseReaction.put("process", "");
//            }
//            String process = otherAdverseReaction.getString("process");
//            process = process.replaceFirst("\\{", "");
//            process = process.replaceFirst("\\}", "");
//            otherAdverseReaction.put("process", process);
//        }
//        log.info("otherAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_otherAdverseReaction);

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


        addProcess(id, step++, "（4）其他：", stringBuilder);
        addProcess(id, step++, "  1）不良反应可逆性", stringBuilder);
        addProcess(id, step++, formatInfo(StringUtils.isNotEmpty(otherAdverseReaction.getString("process")) ? otherAdverseReaction.getString("process") : "暂无相关内容"), stringBuilder);


        addProcess(id, step++, "  2）致畸性、致癌性", stringBuilder);
        addProcess(id, step++, formatInfo(StringUtils.isNotEmpty(genicityAdverseReaction.getString("process")) ? genicityAdverseReaction.getString("process") : "暂无相关内容"), stringBuilder);

        addProcess(id, step++, "3）用药警示：", stringBuilder);
        StringBuilder stringBuilder1 = new StringBuilder();
        float alertAdverseReactionScore = 1f;
        if (StringUtils.isNotEmpty(drugInfo.getBlackBoxWaringOfFDA())) {
            addProcess(id, step++, formatInfo(drugInfo.getBlackBoxWaringOfFDA()), stringBuilder);
            stringBuilder1.append("FDA黑框警告：\n");
            stringBuilder1.append(drugInfo.getBlackBoxWaringOfFDA() + "\n");
            alertAdverseReactionScore = 0f;
        }

//        if (StringUtils.isNotEmpty(drugInfo.getDrugWarning())){
//            addProcess(id, step++, formatInfo(drugInfo.getDrugWarning()), stringBuilder);
//            stringBuilder1.append("\n"+drugInfo.getDrugWarning());
//            alertAdverseReactionScore = 0f;
//
//
//        }


        // 五级中文
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
                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")..."), stringBuilder);
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
                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
                                "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")..."), stringBuilder);
                    }

                }
                alertAdverseReactionScore = 0f;
            }

        }
        if (alertAdverseReactionScore == 1f) {
            addProcess(id, step++, "暂未找到用药警示相关信息", stringBuilder);
            alertAdverseReactionScore = 1f;
            stringBuilder1.append("暂未找到用药警示相关信息");
        }


        float safetyVScore = 0f; // 计算安全分析总得分
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

        // 记录特殊人群总得分
        float specialCrowdScoreCalculate = 0f;
        // 其他得分总等分
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
        safety.getJSONArray("table").add(Arrays.asList("3", "孕妇及哺乳期妇女", (StrUtil.isNotBlank(drugInfo.getPregnantWomen()) ? StrUtil.replace(drugInfo.getPregnantWomen(), "<br>", "") : specialCrowd_pregnantWomen.getString("process")), formatNumber(pregnantAndLactating == 0f ? 0 : pregnantAndLactating)));

        float childrenMedicineScore = 0f;
        try {
//            childrenMedicineScore = Float.parseFloat(specialCrowd_childrenMedicine.getString("score"));
            childrenMedicineScore += Float.parseFloat(formatScore(new BigDecimal(specialCrowd_childrenMedicine.getString("score")).setScale(2, RoundingMode.HALF_UP).toString()));
            safetyVScore += childrenMedicineScore;
            specialCrowdScoreCalculate += childrenMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("4", "儿童", (StrUtil.isNotBlank(drugInfo.getChildrenMedicine()) ? StrUtil.replace(drugInfo.getChildrenMedicine(), "<br>", "") : specialCrowd_childrenMedicine.getString("process")), formatNumber(childrenMedicineScore == 0f ? 0 : childrenMedicineScore)));

        float geriatricMedicineScore = 0f;
        try {
            geriatricMedicineScore = Float.parseFloat(specialCrowd_geriatricMedicine.getString("score"));
            safetyVScore += geriatricMedicineScore;
            specialCrowdScoreCalculate += geriatricMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("5", "老人", (StrUtil.isNotBlank(drugInfo.getGeriatricMedicine()) ? StrUtil.replace(drugInfo.getGeriatricMedicine(), "<br>", "") : specialCrowd_geriatricMedicine.getString("process")), formatNumber(geriatricMedicineScore == 0f ? 0 : geriatricMedicineScore)));

        float liverAndKidney = 0f;
        try {
            liverAndKidney = Float.parseFloat(specialCrowd_liverKidney.getString("liverScore")) + Float.parseFloat(specialCrowd_liverKidney.getString("kidneyScore"));
            safetyVScore += liverAndKidney;
            specialCrowdScoreCalculate += liverAndKidney;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("6", "肝肾功能异常者", specialCrowd_liverKidney.getString("process"), formatNumber(liverAndKidney == 0f ? 0 : liverAndKidney)));

        float drugInteractionScore = 0f;
        try {
            drugInteractionScore = Float.parseFloat(drugInteraction.getString("score"));
            safetyVScore += drugInteractionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
//        safety.getJSONArray("table").add(Arrays.asList("7","相互作用",StrUtil.isNotBlank(drugInfo.getDrugInteraction())?drugInfo.getDrugInteraction():drugInteraction.getString("process"), drugInteractionScore));
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
            genicityAdverseReactionScore = Float.parseFloat(genicityAdverseReaction.getString("score"));
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

        String string = stringBuilder1.toString();

        safety.getJSONArray("table").add(Arrays.asList("8", "不良反应可逆性", otherAdverseReaction.getString("process"), formatNumber(otherAdverseReactionScore == 0f ? 0 : otherAdverseReactionScore)));
        safety.getJSONArray("table").add(Arrays.asList("9", "致畸性、致癌性", genicityAdverseReaction.getString("process"), formatNumber(genicityAdverseReactionScore == 0f ? 0 : genicityAdverseReactionScore)));
        safety.getJSONArray("table").add(Arrays.asList("10", "用药警示", StringUtils.stripEnd(string, "\n"), formatNumber(alertAdverseReactionScore)));
        String safetyOtherScore = formatNumber(otherScore);
        String safetyFormatScore = formatScore(new BigDecimal(safetyVScore).setScale(2, RoundingMode.HALF_UP).toString());
        String specialCrowdScoreTotal = formatScore(new BigDecimal(specialCrowdScoreCalculate).setScale(2, RoundingMode.HALF_UP).toString());
        safety.put("specialPopulationsScore", specialCrowdScoreTotal);
        safety.put("safetyOtherScore", safetyOtherScore);
        safety.put("score", "安全性得分：" + safetyFormatScore + "分");
        safety.put("vscore", safetyFormatScore);
        result.put("safety", safety);
        result.put("time", DateUtil.formatDateTime(new Date()));

        return step;
    }

    private int safetyAnalysisPc(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<String> stringBuilder) {
        // 3 安全性部分
        JSONObject safety = new JSONObject();
        safety.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其安全性进行评价：总分25分，主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
        safety.put("details", new JSONObject());
        safety.put("specialPopulationsScore", "");
        safety.put("table", new JSONArray().fluentAdd(Arrays.asList("序号", "评价条目", "相关内容", "得分")));

        addProcess(id, step++, "<b>3、安全性</b>", stringBuilder);
        addProcess(id, step++, "主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。", stringBuilder);

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

        addProcess(id, step++, "（1）不良反应：", stringBuilder);
        addProcess(id, step++, formatInfo("中度不良反应：" + adverseReaction.getString("mildAdverseReaction")), stringBuilder);
        addProcess(id, step++, formatInfo("重度不良反应：" + adverseReaction.getString("severeAdverseReaction")), stringBuilder);

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

        addProcess(id, step++, "（2）特殊人群：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPregnantWomen())) {
            addProcess(id, step++, formatInfo("孕妇及哺乳期妇女:" + drugInfo.getPregnantWomen()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("孕妇及哺乳期妇女:" + specialCrowd_pregnantWomen.getString("process")), stringBuilder);
        }

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

        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getChildrenMedicine())) {
            addProcess(id, step++, formatInfo("儿童:" + drugInfo.getChildrenMedicine()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("儿童:" + specialCrowd_childrenMedicine.getString("process")), stringBuilder);
        }


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

        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getGeriatricMedicine())) {
            addProcess(id, step++, formatInfo("老年:" + drugInfo.getGeriatricMedicine()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo("老年:" + specialCrowd_geriatricMedicine.getString("process")), stringBuilder);
        }


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

        addProcess(id, step++, formatInfo("肝肾功能异常者:" + specialCrowd_liverKidney.getString("process")), stringBuilder);


//        // 3.3 药物相互作用
//        long begin_drugInteraction = System.currentTimeMillis();
//        JSONObject drugInteraction = new JSONObject();
//        try {
//            drugInteraction = this.drugInteraction(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (drugInteraction.getString("score") == null) {
//                drugInteraction.put("score", 0);
//            }
//            if (drugInteraction.getString("process") == null) {
//                drugInteraction.put("process", "");
//            }
//        }
//        log.info("drugInteraction  gpt  分析时长{}", System.currentTimeMillis() - begin_drugInteraction);

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

        addProcess(id, step++, "（3）药物相互作用所致不良反应：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getDrugInteraction())) {
//            addProcess(id,step++,formatInfo(drugInfo.getDrugInteraction()));
//        } else {
//            addProcess(id,step++,formatInfo(drugInteraction.getString("process")));
//        }
        addProcess(id, step++, formatInfo(drugInteraction.getString("process")), stringBuilder);


//        // 3.4 其他不良反应
//        long begin_otherAdverseReaction = System.currentTimeMillis();
//        JSONObject otherAdverseReaction = new JSONObject();
//        try {
//            otherAdverseReaction = this.otherAdverseReaction(drugName, disease, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (otherAdverseReaction.getString("score") == null) {
//                otherAdverseReaction.put("score", 0);
//            }
//            if (otherAdverseReaction.getString("process") == null) {
//                otherAdverseReaction.put("process", "");
//            }
//            String process = otherAdverseReaction.getString("process");
//            process = process.replaceFirst("\\{", "");
//            process = process.replaceFirst("\\}", "");
//            otherAdverseReaction.put("process", process);
//        }
//        log.info("otherAdverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_otherAdverseReaction);

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

        addProcess(id, step++, "（4）其他：", stringBuilder);
        addProcess(id, step++, formatInfo(otherAdverseReaction.getString("process")), stringBuilder);

        float safetyVScore = 0f; // 计算安全分析总得分
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

        // 记录特殊人群总得分
        float specialCrowdScoreCalculate = 0f;

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
        safety.getJSONArray("table").add(Arrays.asList("3", "孕妇及哺乳期妇女", (StrUtil.isNotBlank(drugInfo.getPregnantWomen()) ? StrUtil.replace(drugInfo.getPregnantWomen(), "<br>", "") : specialCrowd_pregnantWomen.getString("process")), formatNumber(pregnantAndLactating == 0f ? 0 : pregnantAndLactating)));

        float childrenMedicineScore = 0f;
        try {
//            childrenMedicineScore = Float.parseFloat(specialCrowd_childrenMedicine.getString("score"));
            childrenMedicineScore += Float.parseFloat(formatScore(new BigDecimal(specialCrowd_childrenMedicine.getString("score")).setScale(2, RoundingMode.HALF_UP).toString()));
            safetyVScore += childrenMedicineScore;
            specialCrowdScoreCalculate += childrenMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("4", "儿童", (StrUtil.isNotBlank(drugInfo.getChildrenMedicine()) ? StrUtil.replace(drugInfo.getChildrenMedicine(), "<br>", "") : specialCrowd_childrenMedicine.getString("process")), formatNumber(childrenMedicineScore == 0f ? 0 : childrenMedicineScore)));

        float geriatricMedicineScore = 0f;
        try {
            geriatricMedicineScore = Float.parseFloat(specialCrowd_geriatricMedicine.getString("score"));
            safetyVScore += geriatricMedicineScore;
            specialCrowdScoreCalculate += geriatricMedicineScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("5", "老人", (StrUtil.isNotBlank(drugInfo.getGeriatricMedicine()) ? StrUtil.replace(drugInfo.getGeriatricMedicine(), "<br>", "") : specialCrowd_geriatricMedicine.getString("process")), formatNumber(geriatricMedicineScore == 0f ? 0 : geriatricMedicineScore)));

        float liverAndKidney = 0f;
        try {
            liverAndKidney = Float.parseFloat(specialCrowd_liverKidney.getString("liverScore")) + Float.parseFloat(specialCrowd_liverKidney.getString("kidneyScore"));
            safetyVScore += liverAndKidney;
            specialCrowdScoreCalculate += liverAndKidney;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("6", "肝肾功能异常者", specialCrowd_liverKidney.getString("process"), formatNumber(liverAndKidney == 0f ? 0 : liverAndKidney)));

        float drugInteractionScore = 0f;
        try {
            drugInteractionScore = Float.parseFloat(drugInteraction.getString("score"));
            safetyVScore += drugInteractionScore;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
//        safety.getJSONArray("table").add(Arrays.asList("7","相互作用",StrUtil.isNotBlank(drugInfo.getDrugInteraction())?drugInfo.getDrugInteraction():drugInteraction.getString("process"), drugInteractionScore));
        safety.getJSONArray("table").add(Arrays.asList("7", "相互作用", drugInteraction.getString("process"), formatNumber(drugInteractionScore == 0f ? 0 : drugInteractionScore)));

        float otherAdverseReactionScore = 0f;
        try {
            otherAdverseReactionScore = Float.parseFloat(otherAdverseReaction.getString("score"));
            safetyVScore += otherAdverseReactionScore;
        } catch (Exception e) {
            otherAdverseReactionScore = Float.parseFloat("0");
            log.error(e.getMessage(), e);
        }
        safety.getJSONArray("table").add(Arrays.asList("8", "其他不良反应", otherAdverseReaction.getString("process"), formatNumber(otherAdverseReactionScore == 0f ? 0 : otherAdverseReactionScore)));

        String safetyFormatScore = formatScore(new BigDecimal(safetyVScore).setScale(2, RoundingMode.HALF_UP).toString());
        String specialCrowdScoreTotal = formatScore(new BigDecimal(specialCrowdScoreCalculate).setScale(2, RoundingMode.HALF_UP).toString());
        safety.put("specialPopulationsScore", specialCrowdScoreTotal);
        safety.put("score", "安全性得分：" + safetyFormatScore + "分");
        safety.put("vscore", safetyFormatScore);
        result.put("safety", safety);
        result.put("time", DateUtil.formatDateTime(new Date()));

        return step;
    }

    private int effectiveAnalysis(String drugName, String disease,
                                  DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                  Map<Literature, JSONObject> literatureMap, List<String> stringBuilder) {
        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("effectiveness", "");
        effective.put("score", 0);
        effective.put("vscore", 0);
        effective.put("guide", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
        effective.put("guideAndLiteratureScore", 0);

        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        addProcess(id, step++, "主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。", stringBuilder);

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


        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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


        JSONObject indication = new JSONObject();
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

        addProcess(id, step++, "（1）适应证：", stringBuilder);
        addProcess(id, step++, formatInfo(indication.getString("process")), stringBuilder);


        effective.put("indication", indication.getString("process"));
        effective.put("indicationScore", formatScore(indication.getString("score")));

        // 2.2 分析指南  如果有指南就不再分析文献   取分规则是取指南和文献的最高分
        addProcess(id, step++, "（2）证据推荐详情：", stringBuilder);

        List<String> guideTitle = new ArrayList<>();
        int guideIndex = 0;
        // 2.2 指南
        // 等待异步执行完毕中间map有可能收到干扰


        if (CollUtil.isNotEmpty(guideEffectiveMap)) {
            Iterator<Map.Entry<GuideVO, JSONObject>> iterator = guideEffectiveMap.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<GuideVO, JSONObject> guideVOJSONObjectEntry = iterator.next();
                GuideVO guideVO = guideVOJSONObjectEntry.getKey();
                JSONObject guide = guideVOJSONObjectEntry.getValue();

                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
                    // 安全地移除元素
                    iterator.remove();
                    guideIndex++;
                    continue;
                }

                guideTitle.add("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate());

                if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
                    effective.put("guideAndLiteratureScore", formatScore(guide.getString("score")));
                }
                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(guideVO.getTitle());
                jsonArray1.add(guideVO.getZdz());
                jsonArray1.add(guideVO.getFbdate());
                jsonArray1.add("-");
                jsonArray1.add(guideVO.getPdf_txt());
                effective.getJSONArray("guide").add(jsonArray1);
            }
        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap)) {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "reserveGuide")) {
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
                if (!StrUtil.isNumeric(guideEffective.getString("score")) || StrUtil.isBlank(guideEffective.getString("process"))) {
                    continue;
                }

                guideTitle.add("《" + searchHit.getTitle() + "》 —— " + searchHit.getZdz() + " —— " + searchHit.getFbdate());

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

        if (CollUtil.isNotEmpty(guideTitle)) {
//            addProcess(id, step++, "&nbsp;&nbsp;&nbsp; 指南推荐：");
            for (String title : guideTitle) {
                addProcess(id, step++, title, stringBuilder);
            }
        }

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
//            if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
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
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "literatureResult")) {
                    Future<Boolean> literatureResult = futureEntry.getValue();
                    try {
                        literatureResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "literature_")) {
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
                    if (!StrUtil.isNumeric(literatureAnalysis.getString("score"))
                            || StrUtil.isBlank(literatureAnalysis.getString("process"))
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

            if (CollUtil.isNotEmpty(literatureTitleList)) {
//                addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 文献推荐：");
                for (String title : literatureTitleList) {
                    addProcess(id, step++, title, stringBuilder);
                }
            } else {
                addProcess(id, step++, "暂未找到相关临床指南或系统评价/Meta分析等证据推荐。", stringBuilder);
            }
        }


//        List<String> literatureTitleList = new ArrayList<>();
//        effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
//        // 如果没有指南进行分析 就再分析文献
//        if (effective.getInteger("guideAndLiteratureScore") == 0) {
////            effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
////            addProcess(id,step ++,"&nbsp;&nbsp;&nbsp;② 文献推荐：");
//            List<String> literatureTitle = new ArrayList<>();
//            for (Literature literature : literatureList) {
//                long begin_literature = System.currentTimeMillis();
//                JSONObject guide = new JSONObject();
//                try {
//                    String summary = literature.getSummary();
//                    guide = this.guide(drugName, disease, summary, null, null);
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
//                log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_literature);
//
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                    guideIndex++;
//                    continue;
//                }
//
//                if (!StrUtil.isNumeric(guide.getString("score"))
//                        || StrUtil.isBlank(guide.getString("process"))
//                        || CollUtil.contains(literatureTitle, literature.getTitle()))
//                {
//                    continue;
//                }
//
//                // 因为文献的名字存在相同 但是 文献id不同的情况 去重
//                literatureTitle.add(literature.getTitle());
////                addProcess(id,step++,"《"+literature.getTitle()+"》");
//                literatureTitleList.add("《"+literature.getTitle()+"》");
//                if(effective.getInteger("guideAndLiteratureScore")==0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
//                    effective.put("guideAndLiteratureScore", guide.getString("score"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(literature.getTitle());
//                jsonArray1.add(literature.getJournal());
//                jsonArray1.add(literature.getYear());
//                jsonArray1.add(guide.getString("process"));
//                effective.getJSONArray("literature").add(jsonArray1);
//            }
//
//            if (CollUtil.isNotEmpty(literatureTitleList)) {
//                addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 文献推荐：");
//                for (String title : literatureTitleList) {
//                    addProcess(id,step++,title);
//                }
//            } else {
//                addProcess(id,step ++,"暂无找到相关证据推荐。");
//            }
//        }

//        addProcess(id,step++,"&nbsp;暂时无法找到该药物治疗此疾病的相关文献推荐");

        // 2.3 临床疗效
//        long begin_clinical = System.currentTimeMillis();
//        JSONObject clinical = new JSONObject();
//        try {
//            clinical = this.clinical(drugName, disease);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (clinical.getString("score") == null) {
//                clinical.put("score", 0);
//            }
//            if (clinical.getString("process") == null) {
//                clinical.put("process", "");
//            }
//        }
//        log.info("clinical  gpt  分析时长{}", System.currentTimeMillis() - begin_clinical);

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

        addProcess(id, step++, "（3）临床疗效：", stringBuilder);
        addProcess(id, step++, formatInfo(clinical.getString("process")), stringBuilder);
        effective.put("effectiveness", clinical.getString("process"));
        effective.put("effectivenessScore", formatScore(clinical.getString("score")));

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

        return step;
    }


    private int effectiveAnalysisPc(String drugName, String disease,
                                    DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, List<GuideDto> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap,
                                    Map<Literature, JSONObject> literatureMap, List<String> stringBuilder) {
        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("effectiveness", "");
        effective.put("score", 0);
        effective.put("vscore", 0);
        effective.put("guidePc", new JSONArray());
        effective.put("guideAndLiteratureScore", 0);

        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        addProcess(id, step++, "主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。", stringBuilder);

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

        addProcess(id, step++, "（1）适应证：", stringBuilder);
        addProcess(id, step++, formatInfo(indication.getString("process")), stringBuilder);


        effective.put("indication", indication.getString("process"));
        effective.put("indicationScore", formatScore(indication.getString("score")));

        // 2.2 分析指南  如果有指南就不再分析文献   取分规则是取指南和文献的最高分
        addProcess(id, step++, "（2）证据推荐详情：", stringBuilder);

        List<String> guideTitle = new ArrayList<>();
        int guideIndex = 0;
        // 2.2 指南
        // 等待异步执行完毕中间map有可能收到干扰
        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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


        if (CollUtil.isNotEmpty(guideEffectiveMap)) {
            for (GuideDto guideVOJSONObjectEntry : guideEffectiveMap) {
                GuidelinesVo guideVO = guideVOJSONObjectEntry.getGuidelines();
                JSONObject guide = guideVOJSONObjectEntry.getGuide();
                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
                    guide.put("score", "1");
                }
                guideTitle.add(guideVO.getShowField());
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

                JSONObject jsonObject = new JSONObject();
                jsonObject.put("showField", guideVO.getShowField());
                jsonObject.put("content", guideVO.getContent());
                effective.getJSONArray("guidePc").add(jsonObject);
            }
        }


        if (CollUtil.isNotEmpty(guideTitle)) {
//            addProcess(id, step++, "&nbsp;&nbsp;&nbsp; 指南推荐：");
            for (String title : guideTitle) {
                addProcess(id, step++, title, stringBuilder);
            }
        }

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
//            if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
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
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
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
                if (StrUtil.startWith(futureEntry.getKey(), "literatureResult")) {
                    Future<Boolean> literatureResult = futureEntry.getValue();
                    try {
                        literatureResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "literature_")) {
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
                    if (!StrUtil.isNumeric(literatureAnalysis.getString("score"))
                            || StrUtil.isBlank(literatureAnalysis.getString("process"))
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
                    jsonArray1.add(literature.getSummary());
                    effective.getJSONArray("literature").add(jsonArray1);
                }
            }

            if (CollUtil.isNotEmpty(literatureTitleList)) {
//                addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 文献推荐：");
                for (String title : literatureTitleList) {
                    addProcess(id, step++, title, stringBuilder);
                }
            } else {
                addProcess(id, step++, "暂未找到相关临床指南或系统评价/Meta分析等证据推荐。", stringBuilder);
            }
        }


//        List<String> literatureTitleList = new ArrayList<>();
//        effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
//        // 如果没有指南进行分析 就再分析文献
//        if (effective.getInteger("guideAndLiteratureScore") == 0) {
////            effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
////            addProcess(id,step ++,"&nbsp;&nbsp;&nbsp;② 文献推荐：");
//            List<String> literatureTitle = new ArrayList<>();
//            for (Literature literature : literatureList) {
//                long begin_literature = System.currentTimeMillis();
//                JSONObject guide = new JSONObject();
//                try {
//                    String summary = literature.getSummary();
//                    guide = this.guide(drugName, disease, summary, null, null);
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
//                log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_literature);
//
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                    guideIndex++;
//                    continue;
//                }
//
//                if (!StrUtil.isNumeric(guide.getString("score"))
//                        || StrUtil.isBlank(guide.getString("process"))
//                        || CollUtil.contains(literatureTitle, literature.getTitle()))
//                {
//                    continue;
//                }
//
//                // 因为文献的名字存在相同 但是 文献id不同的情况 去重
//                literatureTitle.add(literature.getTitle());
////                addProcess(id,step++,"《"+literature.getTitle()+"》");
//                literatureTitleList.add("《"+literature.getTitle()+"》");
//                if(effective.getInteger("guideAndLiteratureScore")==0 || effective.getInteger("guideAndLiteratureScore") < guide.getInteger("score")) {
//                    effective.put("guideAndLiteratureScore", guide.getString("score"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(literature.getTitle());
//                jsonArray1.add(literature.getJournal());
//                jsonArray1.add(literature.getYear());
//                jsonArray1.add(guide.getString("process"));
//                effective.getJSONArray("literature").add(jsonArray1);
//            }
//
//            if (CollUtil.isNotEmpty(literatureTitleList)) {
//                addProcess(id,step ++,"&nbsp;&nbsp;&nbsp; 文献推荐：");
//                for (String title : literatureTitleList) {
//                    addProcess(id,step++,title);
//                }
//            } else {
//                addProcess(id,step ++,"暂无找到相关证据推荐。");
//            }
//        }

//        addProcess(id,step++,"&nbsp;暂时无法找到该药物治疗此疾病的相关文献推荐");

        // 2.3 临床疗效
//        long begin_clinical = System.currentTimeMillis();
//        JSONObject clinical = new JSONObject();
//        try {
//            clinical = this.clinical(drugName, disease);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (clinical.getString("score") == null) {
//                clinical.put("score", 0);
//            }
//            if (clinical.getString("process") == null) {
//                clinical.put("process", "");
//            }
//        }
//        log.info("clinical  gpt  分析时长{}", System.currentTimeMillis() - begin_clinical);

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

        addProcess(id, step++, "（3）临床疗效：", stringBuilder);
        addProcess(id, step++, formatInfo(clinical.getString("process")), stringBuilder);
        effective.put("effectiveness", clinical.getString("process"));
        effective.put("effectivenessScore", formatScore(clinical.getString("score")));

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

        return step;
    }

    private int pharmacyAnalysisPc(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, List<String> stringBuilder) {
        JSONObject pharmaceuticalCharacteristics = new JSONObject();
        result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
        pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
        pharmaceuticalCharacteristics.put("table", new JSONArray().fluentAdd(new ArrayList<>(Arrays.asList("序号", "评价条目", "相关内容", "得分"))));
        pharmaceuticalCharacteristics.put("score", 0);
        pharmaceuticalCharacteristics.put("vscore", 0);

        addProcess(id, step++, "<b>1、药学特性</b>", stringBuilder);
        addProcess(id, step++, "主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。", stringBuilder);
        // 1.药理作用
        long begin_pharmacology = System.currentTimeMillis();
        JSONObject pharmacology = new JSONObject();
        try {
            pharmacology = this.pharmacology(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (pharmacology.getString("score") == null) {
                pharmacology.put("score", 0);
            }
            if (pharmacology.getString("process") == null) {
                pharmacology.put("process", "");
            }
        }
        log.info("pharmacology  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacology
        );

        addProcess(id, step++, "（1）药理作用：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPharmacology())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getPharmacology()));
//        } else {
//            addProcess(id,step ++,formatInfo(pharmacology.getString("process")));
//        }
        addProcess(id, step++, formatInfo(pharmacology.getString("process")), stringBuilder);

        // 2.体内过程
        long begin_pharmacokinetics = System.currentTimeMillis();
        JSONObject pharmacokinetics = new JSONObject();
        try {
            pharmacokinetics = this.pharmacokinetics(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (pharmacokinetics.getString("score") == null) {
                pharmacokinetics.put("score", 0);
            }
            if (pharmacokinetics.getString("process") == null) {
                pharmacokinetics.put("process", "");
            }
        }
        log.info("pharmacokinetics  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacokinetics);

        addProcess(id, step++, "（2）体内过程：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPharmacokinetics())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getPharmacokinetics()));
//        } else {
//            addProcess(id,step ++,formatInfo(pharmacokinetics.getString("process")));
//        }
        addProcess(id, step++, formatInfo(pharmacokinetics.getString("process")), stringBuilder);


        // 3.药剂学和使用方法
        long begin_usageAndDosage = System.currentTimeMillis();
        JSONObject usageAndDosage = new JSONObject();
        try {
            usageAndDosage = this.usageAndDosage(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (usageAndDosage.getString("scoreA") == null) {
                usageAndDosage.put("scoreA", 0);
            }
            if (usageAndDosage.getString("scoreB") == null) {
                usageAndDosage.put("scoreB", 0);
            }
            if (usageAndDosage.getString("scoreC") == null) {
                usageAndDosage.put("scoreC", 0);
            }
            if (usageAndDosage.getString("scoreD") == null) {
                usageAndDosage.put("scoreD", 0);
            }
            if (usageAndDosage.getString("scoreE") == null) {
                usageAndDosage.put("scoreE", 0);
            }
            if (usageAndDosage.getString("scoreF") == null) {
                usageAndDosage.put("scoreF", 0);
            }
            if (usageAndDosage.getString("processA") == null) {
                usageAndDosage.put("processA", "");
            }
            if (usageAndDosage.getString("processB") == null) {
                usageAndDosage.put("processB", "");
            }
            if (usageAndDosage.getString("processC") == null) {
                usageAndDosage.put("processC", "");
            }
            if (usageAndDosage.getString("processD") == null) {
                usageAndDosage.put("processD", "");
            }
            if (usageAndDosage.getString("processE") == null) {
                usageAndDosage.put("processE", "");
            }
            if (usageAndDosage.getString("processF") == null) {
                usageAndDosage.put("processF", "");
            }
//            String process = usageAndDosage.getString("process");
//            process = process.replaceFirst("\\{", "");
//            process = process.replaceFirst("}", "");
//            process = process.replaceFirst("\\[", "");
//            process = process.replaceFirst("]", "");
//            usageAndDosage.put("process", process);
        }
        log.info("usageAndDosage  gpt  分析时长{}", System.currentTimeMillis() - begin_usageAndDosage);

        addProcess(id, step++, "（3）药剂学与使用方法：", stringBuilder);
        StringBuilder process_usageAndDosage = new StringBuilder()
                .append(usageAndDosage.getString("processA"))
                .append(usageAndDosage.getString("processB"))
                .append(usageAndDosage.getString("processC"))
                .append(usageAndDosage.getString("processD"))
                .append(usageAndDosage.getString("processE"))
                .append(usageAndDosage.getString("processF"));
        StringBuilder process_usageAndDosage_br = new StringBuilder()
                .append(usageAndDosage.getString("processA")).append("</br>")
                .append(usageAndDosage.getString("processB")).append("</br>")
                .append(usageAndDosage.getString("processC")).append("</br>")
                .append(usageAndDosage.getString("processD")).append("</br>")
                .append(usageAndDosage.getString("processE")).append("</br>")
                .append(usageAndDosage.getString("processF"));
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getUsageAndDosage())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getUsageAndDosage()));
//        } else {
//            addProcess(id,step ++,formatInfo(usageAndDosage.getString("process")));
//        }
        addProcess(id, step++, formatInfo(process_usageAndDosage.toString()), stringBuilder);


        // 4.贮藏条件
        long begin_storage = System.currentTimeMillis();
        JSONObject storage = new JSONObject();
        try {
            storage = this.storage(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (storage.getString("score") == null) {
                storage.put("score", 0);
            }
            if (storage.getString("process") == null) {
                storage.put("process", "");
            }
        }
        log.info("storage  gpt  分析时长{}", System.currentTimeMillis() - begin_storage);

        addProcess(id, step++, "（4）贮藏条件：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getStorage())) {
            addProcess(id, step++, formatInfo(drugInfo.getStorage()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo(storage.getString("process")), stringBuilder);
        }
//        addProcess(id,step ++,formatInfo(storage.getString("process")));


        // 5.药品有效期
        long begin_indate = System.currentTimeMillis();
        JSONObject indate = new JSONObject();
        try {
            indate = this.indate(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (indate.getString("score") == null) {
                indate.put("score", 0);
            }
            if (indate.getString("process") == null) {
                indate.put("process", "");
            }
        }
        log.info("indate  gpt  分析时长{}", System.currentTimeMillis() - begin_indate);

        addProcess(id, step++, "（5）药品有效期：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getIndate())) {
            addProcess(id, step++, formatInfo(drugInfo.getIndate()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo(indate.getString("process")), stringBuilder);
        }
//        addProcess(id,step ++,formatInfo(indate.getString("process")));


        float pharmacyAnalysisScore = 0f;
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
        float usageAndDosageScore = 0f;
        try {
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreA"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreA"));
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreB"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreB"));
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreC"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreC"));
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreD"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreD"));
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreE"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreE"));
            pharmacyAnalysisScore += Float.parseFloat(usageAndDosage.getString("scoreF"));
            usageAndDosageScore += Float.parseFloat(usageAndDosage.getString("scoreF"));
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

        try {
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", StrUtil.isNotBlank(drugInfo.getPharmacology()) ? drugInfo.getPharmacology() : pharmacology.getString("process"), pharmacology.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", pharmacology.getString("process"), formatScore(pharmacology.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", StrUtil.isNotBlank(drugInfo.getPharmacokinetics()) ? drugInfo.getPharmacokinetics() : pharmacokinetics.getString("process"), pharmacokinetics.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", pharmacokinetics.getString("process"), formatScore(pharmacokinetics.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", StrUtil.isNotBlank(drugInfo.getUsageAndDosage()) ? drugInfo.getUsageAndDosage() : usageAndDosage.getString("process"), usageAndDosage.getString("score"))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法",  usageAndDosage.getString("process"), usageAndDosage.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", process_usageAndDosage_br.toString(), formatNumber(usageAndDosageScore))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", StrUtil.isNotBlank(drugInfo.getStorage()) ? drugInfo.getStorage() : storage.getString("process"), formatScore(storage.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", storage.getString("process"), storage.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", StrUtil.isNotBlank(drugInfo.getIndate()) ? drugInfo.getIndate() : indate.getString("process"), formatScore(indate.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", indate.getString("process"), indate.getString("score"))));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        // 计算药学特性部分总得分
        String pharmacyFormatScore = formatScore(new BigDecimal(pharmacyAnalysisScore).setScale(2, RoundingMode.HALF_UP).toString());
        pharmaceuticalCharacteristics.put("score", "药学特性得分：" + pharmacyFormatScore + "分");
        pharmaceuticalCharacteristics.put("vscore", pharmacyFormatScore);

        return step;
    }

    private int pharmacyAnalysis(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, List<String> stringBuilder) {
        JSONObject pharmaceuticalCharacteristics = new JSONObject();
        result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
        pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
        pharmaceuticalCharacteristics.put("table", new JSONArray().fluentAdd(new ArrayList<>(Arrays.asList("序号", "评价条目", "相关内容", "得分"))));
        pharmaceuticalCharacteristics.put("score", 0);
        pharmaceuticalCharacteristics.put("vscore", 0);

        addProcess(id, step++, "<b>1、药学特性</b>", stringBuilder);
        addProcess(id, step++, "主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。", stringBuilder);
        // 1.药理作用
        long begin_pharmacology = System.currentTimeMillis();
        JSONObject pharmacology = new JSONObject();
        try {
            boolean has = false;
            if (StrUtil.isNotBlank(drugInfo.getPharmacology())) {
                String key = SecurityUtil.getMd5(drugName + "pharmacology");
                String gptRedis = getGptRedis(key);
                if (StrUtil.isNotEmpty(gptRedis)) {
                    pharmacology = JSONObject.parseObject(gptRedis);
                    has = true;
                }
            }
            if (!has) {
                pharmacology = this.pharmacology(drugName, disease, drugInfo);
                if (StrUtil.isNotBlank(drugInfo.getPharmacology())) {
                    String key = GPT_REDIS_KEY + SecurityUtil.getMd5(drugName + "pharmacology");
                    redisTemplate.opsForValue().set(key, pharmacology.toJSONString(), 24, TimeUnit.HOURS);
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (pharmacology.getString("score") == null) {
                pharmacology.put("score", 0);
            }
            if (StringUtils.isNotEmpty(drugInfo.getPharmacology())) {
                pharmacology.put("process", drugInfo.getPharmacology());
            } else if (pharmacology.getString("process") == null) {
                pharmacology.put("process", pharmacology.getString("process"));
            }
        }
        log.info("pharmacology  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacology
        );

        addProcess(id, step++, "（1）药理作用：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPharmacology())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getPharmacology()));
//        } else {
//            addProcess(id,step ++,formatInfo(pharmacology.getString("process")));
//        }
        addProcess(id, step++, formatInfo(pharmacology.getString("process")), stringBuilder);

        // 2.体内过程
        long begin_pharmacokinetics = System.currentTimeMillis();
        JSONObject pharmacokinetics = new JSONObject();
        try {
            boolean has = false;
            if (drugInfo.getHasPharmacokinetics()) {
                String key = SecurityUtil.getMd5(drugName + "pharmacokinetics");
                String gptRedis = getGptRedis(key);
                if (StrUtil.isNotEmpty(gptRedis)) {
                    pharmacokinetics = JSONObject.parseObject(gptRedis);
                    has = true;
                }
            }
            if (!has) {
                pharmacokinetics = this.pharmacokinetics(drugName, disease, drugInfo);
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
            }
            if (pharmacokinetics.getString("process") == null) {
                pharmacokinetics.put("process", "");
            }
            if (StringUtils.isNotEmpty(drugInfo.getPharmacokinetics())) {
                pharmacokinetics.put("process", drugInfo.getPharmacokinetics());
            }
        }
        log.info("pharmacokinetics  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacokinetics);

        addProcess(id, step++, "（2）体内过程：", stringBuilder);
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getPharmacokinetics())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getPharmacokinetics()));
//        } else {
//            addProcess(id,step ++,formatInfo(pharmacokinetics.getString("process")));
//        }
        addProcess(id, step++, formatInfo(pharmacokinetics.getString("process")), stringBuilder);


        // 3.药剂学和使用方法
        long begin_usageAndDosage = System.currentTimeMillis();
        JSONObject usageAndDosage = new JSONObject();
        try {

            String promptA = "请分析一下" + drugName + "的主要成分与辅料是否明确，需要根据提供的成分信息进行真实描述，不要猜测结果。相关成分信息：" + drugInfo.getIngredient() + ";" +
                    "并根据以下评分规则给予一个得分，单选：" +
                    "2分：主要成分与辅料均明确。" +
                    "1分：主要成分明确或辅料明确。";

            HashMap<String, String> stringStringHashMap5 = new HashMap<>();
            stringStringHashMap5.put("processA", "主要成分与辅料是否明确");
            stringStringHashMap5.put("scoreA", "打分（务必是数字:int或者double类型）");
            JSONObject responseFormat5 = getResponseFormat(stringStringHashMap5);
            JSONObject jsonObject6 = executeGptPlus(promptA, "pharmacology", responseFormat5, "","2,1,0");

            String scoreA = jsonObject6.getString("scoreA");
            String processA = jsonObject6.getString("processA");

            usageAndDosage.put("scoreA", extractLastNumberx(scoreA));
            usageAndDosage.put("processA", processA);


            // 包装
            String promptB = "请你作为一名专业的西药临床药师，根据说明书中药品规格、包装与用法用量信息，分析一下" + drugName + "的规格与包装是否适宜临床使用，或者是否方便临床上进行剂量调整，并结合以下评分规则给予一个得分，单选：" +
                    "返回参数scoreB（打分）和processB（原因）" +
                    "2分：规格适宜临床应用或者剂量调整，且包装适宜临床应用或者剂量调整。" +
                    "1分：规格适宜临床应用或者剂量调整，或者包装适宜临床应用或者剂量调整。" +
                    "药品规格信息" + drugInfo.getSpecifications() + ";" + "包装信息:" + drugInfo.getPack() + "药品用法用量信息" + drugInfo.getSpecifications();

            HashMap<String, String> stringStringHashMap4 = new HashMap<>();
            stringStringHashMap4.put("scoreB", "包装分数（只能是阿拉伯数字组成）");
            stringStringHashMap4.put("processB", "包装得分原因");

            JSONObject jsonObject4 = executeGptPlus(promptB, "package", getResponseFormat(stringStringHashMap4), "","2,1,0");

            String processB = jsonObject4.getString("processB");
            String scoreB = jsonObject4.getString("scoreB");

            usageAndDosage.put("processB", processB);
            usageAndDosage.put("scoreB", extractLastNumberx(scoreB));


            // 剂型
            String promptC = "请分析一下" + drugName + "的剂型是什么，" + "剂型信息：" + drugInfo.getDosageForm() + "，" +
                    "并根据以下评分规则给予一个得分（注意：若药品存在多个给药途径时，分值采用就高原则）：" +
                    "返回参数scoreC（打分）和processC（原因）" +
                    "2分：口服制剂/吸入制剂/外用制剂。" +
                    "1.5分：皮下注射剂/肌内注射剂。" +
                    "1分：静脉滴注/静脉注射剂。\n";

            HashMap<String, String> stringStringHashMap3 = new HashMap<>();
            stringStringHashMap3.put("scoreC", "剂型分数（只能是阿拉伯数字组成）");
            stringStringHashMap3.put("processC", "剂型得分原因");
            JSONObject dosageFormResult = executeGptPlus(promptC, "剂型", getResponseFormat(stringStringHashMap3), "","2,1.5,1");
            String dosageFormResultContent = dosageFormResult.getString("processC");
            String scoreC = dosageFormResult.getString("scoreC");

            usageAndDosage.put("processC", dosageFormResultContent);
            usageAndDosage.put("scoreC", extractLastNumberx(scoreC));


            // 固定计量
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
            JSONObject jsonObject2 = executeGptPlus(promptD, "dose", responseFormat2, "","2,1.5,1");
            String processD = jsonObject2.getString("processD");
            String scoreD = jsonObject2.getString("scoreD");
            usageAndDosage.put("processD", processD);
            usageAndDosage.put("scoreD", extractLastNumberx(scoreD));


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
            JSONObject theorySupportResult1 = executeGptPlus(promptE, "给药频次支持", getResponseFormat(stringStringHashMap1), "","2,1.5,1,0");
            String processE = theorySupportResult1.getString("processE");
            String scoreE = theorySupportResult1.getString("scoreE");
            usageAndDosage.put("processE", processE);
            usageAndDosage.put("scoreE", extractLastNumberx(scoreE));


            // 使用方法

            String promptF = "请根据以下信息，给出有关【" + drugName + "】的【使用方法】。【" + drugName + "】的【使用方法】是：" +
                    drugInfo.getUsageAndDosage() + "。" +
                    "请评价" + drugName + "在使用过程中的便利性，是否需要他人帮助或训练后才能自行给药，或者不可自行给药，需要医务人员辅助，" +
                    "并根据以下评分规则给予一个得分：" +
                    "2分：使用方便，无需辅助，可自行给药。" +
                    "1.5分：使用方便，无需辅助，需在他人帮助或训练后自行给药。" +
                    "1分：使用较为繁琐，需医务人员给药。" +
                    "  请注意：" +
                    "（1）如果患者能自行服药，直接给2分。如口服制剂与外用制剂等。" +
                    "（2）如果是吸入剂，部分吸入剂器械的使用可能需要医护人员指导后使用，给1.5分。" +
                    "（3）如果是需要医护人员帮助才能用药的情况，给1分，如注射用药。" +
                    "（4）你需要根据我提供给你的用法用量信息或者你自己的知识库信息加以判断，以上三项并不是严格标准。";

            HashMap<String, String> stringStringHashMap = new HashMap<>();
            stringStringHashMap.put("score", "使用方便的得分");
            stringStringHashMap.put("process", "使用方便分");

            JSONObject jsonObject1 = executeGptPlus(promptF, "usageAndDosage", getResponseFormat(stringStringHashMap), "","2,1.5,1,0");
            usageAndDosage.put("scoreF", extractLastNumberx(jsonObject1.getString("score")));
            usageAndDosage.put("processF", jsonObject1.getString("process"));


        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (usageAndDosage.getString("scoreA") == null) {
                usageAndDosage.put("scoreA", 0);
            }
            if (usageAndDosage.getString("scoreB") == null) {
                usageAndDosage.put("scoreB", 0);
            }
            if (usageAndDosage.getString("scoreC") == null) {
                usageAndDosage.put("scoreC", 0);
            }
            if (usageAndDosage.getString("scoreD") == null) {
                usageAndDosage.put("scoreD", 0);
            }
            if (usageAndDosage.getString("scoreE") == null) {
                usageAndDosage.put("scoreE", 0);
            }
            if (usageAndDosage.getString("scoreF") == null) {
                usageAndDosage.put("scoreF", 0);
            }
            if (usageAndDosage.getString("processA") == null) {
                usageAndDosage.put("processA", "");
            } else {
                usageAndDosage.put("processA", usageAndDosage.getString("processA") + "本项得" + usageAndDosage.getString("scoreA") + "分");
            }
            if (usageAndDosage.getString("processB") == null) {
                usageAndDosage.put("processB", "");
            } else {
                usageAndDosage.put("processB", usageAndDosage.getString("processB") + "本项得" + usageAndDosage.getString("scoreB") + "分");
            }
            if (usageAndDosage.getString("processC") == null) {
                usageAndDosage.put("processC", "");
            } else {
                usageAndDosage.put("processC", usageAndDosage.getString("processC") + "本项得" + usageAndDosage.getString("scoreC") + "分");
            }
            if (usageAndDosage.getString("processD") == null) {
                usageAndDosage.put("processD", "");
            } else {
                usageAndDosage.put("processD", usageAndDosage.getString("processD") + "本项得" + usageAndDosage.getString("scoreD") + "分");
            }
            if (usageAndDosage.getString("processE") == null) {
                usageAndDosage.put("processE", "");
            } else {
                usageAndDosage.put("processE", usageAndDosage.getString("processE") + "本项得" + usageAndDosage.getString("scoreE") + "分");
            }
            if (usageAndDosage.getString("processF") == null) {
                usageAndDosage.put("processF", "");
            } else {
                usageAndDosage.put("processF", usageAndDosage.getString("processF"));
            }
//            String process = usageAndDosage.getString("process");
//            process = process.replaceFirst("\\{", "");
//            process = process.replaceFirst("}", "");
//            process = process.replaceFirst("\\[", "");
//            process = process.replaceFirst("]", "");
//            usageAndDosage.put("process", process);
        }
        log.info("usageAndDosage  gpt  分析时长{}", System.currentTimeMillis() - begin_usageAndDosage);

        addProcess(id, step++, "（3）药剂学与使用方法：", stringBuilder);
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


        StringBuilder process_usageAndDosage = new StringBuilder()
                .append("  成分：" + ingredient)
                .append("  规格与包装：" + sp)
                .append("  剂型：" + dosageForm)
                .append("  用法用量：" + usag);
        StringBuilder process_usageAndDosage_br = new StringBuilder()
                .append("成分：" + ingredient).append("</br>")
                .append("规格与包装：" + sp).append("</br>")
                .append("剂型：" + dosageForm).append("</br>")
                .append("用法用量：" + usag).append("</br>")
                .append("使用方便：" + usageAndDosage.getString("processF"));
//        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getUsageAndDosage())) {
//            addProcess(id,step ++,formatInfo(drugInfo.getUsageAndDosage()));
//        } else {
//            addProcess(id,step ++,formatInfo(usageAndDosage.getString("process")));
//        }
//        addProcess(id, step++, formatInfo(process_usageAndDosage.toString()), stringBuilder);

        addProcess(id, step++, formatInfo("1）成分"), stringBuilder);
        addProcess(id, step++, formatInfo(StringUtils.isNotEmpty(ingredient) ? ingredient : usageAndDosage.getString("processA")), stringBuilder);
        addProcess(id, step++, formatInfo("2）规格与包装"), stringBuilder);
        addProcess(id, step++, formatInfo(StringUtils.isNotEmpty(sp) ? sp : usageAndDosage.getString("processB")), stringBuilder);
        addProcess(id, step++, formatInfo("3）剂型"), stringBuilder);
        addProcess(id, step++, formatInfo(StringUtils.isNotEmpty(dosageForm) ? dosageForm : usageAndDosage.getString("processC")), stringBuilder);
        addProcess(id, step++, formatInfo("4）给药剂量"), stringBuilder);
        addProcess(id, step++, formatInfo(usageAndDosage.getString("processD")), stringBuilder);
        addProcess(id, step++, formatInfo("5）给要频次"), stringBuilder);
        addProcess(id, step++, formatInfo(usageAndDosage.getString("processE")), stringBuilder);
        addProcess(id, step++, formatInfo("6）使用方便"), stringBuilder);
        addProcess(id, step++, formatInfo(usageAndDosage.getString("processF")), stringBuilder);


        // 4.贮藏条件
        long begin_storage = System.currentTimeMillis();
        JSONObject storage = new JSONObject();
        try {
            storage = this.storage(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (storage.getString("score") == null) {
                storage.put("score", 0);
            }
            if (storage.getString("process") == null) {
                storage.put("process", "");
            }
        }
        log.info("storage  gpt  分析时长{}", System.currentTimeMillis() - begin_storage);

        addProcess(id, step++, "（4）贮藏条件：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getStorage())) {
            addProcess(id, step++, formatInfo(drugInfo.getStorage()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo(storage.getString("process")), stringBuilder);
        }
//        addProcess(id,step ++,formatInfo(storage.getString("process")));


        // 5.药品有效期
        long begin_indate = System.currentTimeMillis();
        JSONObject indate = new JSONObject();
        try {
            indate = this.indate(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (indate.getString("score") == null) {
                indate.put("score", 0);
            }
            if (indate.getString("process") == null) {
                indate.put("process", "");
            }
        }
        log.info("indate  gpt  分析时长{}", System.currentTimeMillis() - begin_indate);

        addProcess(id, step++, "（5）药品有效期：", stringBuilder);
        if (Objects.nonNull(drugInfo) && StrUtil.isNotBlank(drugInfo.getIndate())) {
            addProcess(id, step++, formatInfo(drugInfo.getIndate()), stringBuilder);
        } else {
            addProcess(id, step++, formatInfo(indate.getString("process")), stringBuilder);
        }
//        addProcess(id,step ++,formatInfo(indate.getString("process")));


        float pharmacyAnalysisScore = 0f;
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

        try {
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", StrUtil.isNotBlank(drugInfo.getPharmacology()) ? drugInfo.getPharmacology() : pharmacology.getString("process"), pharmacology.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", pharmacology.getString("process"), formatScore(pharmacology.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", StrUtil.isNotBlank(drugInfo.getPharmacokinetics()) ? drugInfo.getPharmacokinetics() : pharmacokinetics.getString("process"), pharmacokinetics.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", pharmacokinetics.getString("process"), formatScore(pharmacokinetics.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", StrUtil.isNotBlank(drugInfo.getUsageAndDosage()) ? drugInfo.getUsageAndDosage() : usageAndDosage.getString("process"), usageAndDosage.getString("score"))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法",  usageAndDosage.getString("process"), usageAndDosage.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", "", formatNumber(usageAndDosageScore))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.1", "成分", StringUtils.isNotEmpty(ingredient) ? ingredient : usageAndDosage.getString("processA"), formatScore(usageAndDosage.getString("scoreA")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.2", "规格与包装", StringUtils.isNotEmpty(sp) ? sp : usageAndDosage.getString("processB"), formatScore(usageAndDosage.getString("scoreB")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.3", "剂型", StringUtils.isNotEmpty(dosageForm) ? dosageForm : usageAndDosage.getString("processC"), formatScore(usageAndDosage.getString("scoreC")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.4", "给药剂量", usageAndDosage.getString("processD"), formatScore(usageAndDosage.getString("scoreD")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.5", "给药频次", usageAndDosage.getString("processE"), formatScore(usageAndDosage.getString("scoreE")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3.6", "使用方便性", usageAndDosage.getString("processF"), formatScore(usageAndDosage.getString("scoreF")))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", StrUtil.isNotBlank(drugInfo.getStorage()) ? drugInfo.getStorage() : storage.getString("process"), formatScore(storage.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", storage.getString("process"), storage.getString("score"))));
            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", StrUtil.isNotBlank(drugInfo.getIndate()) ? drugInfo.getIndate() : indate.getString("process"), formatScore(indate.getString("score")))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", indate.getString("process"), indate.getString("score"))));
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        // 计算药学特性部分总得分
        String pharmacyFormatScore = formatScore(new BigDecimal(pharmacyAnalysisScore).setScale(2, RoundingMode.HALF_UP).toString());
        pharmaceuticalCharacteristics.put("score", "药学特性得分：" + pharmacyFormatScore + "分");
        pharmaceuticalCharacteristics.put("vscore", pharmacyFormatScore);

        return step;
    }

//    /**
//     * 存留的上一版的guidePanel 指南分析检索
//     */
//
//    @Override
//    public JSONObject guidePanel_bbbbbbak(String drugInfo, String disease, String specifications, String id, String priceId, long userId, String isCustom) {
//        /*
//        JSONObject result = new JSONObject();
//        String[] arr = drugInfo.split("-");
//        String drugName = arr[0];
//        String enterpriseName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];
//        result.put("disease", disease);
//        result.put("ts", System.currentTimeMillis());
//        result.put("cache_key", drugInfo + "_" + disease);
//
//        // 用来存放drug 和 disease同义词list
//        List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
//        List<String> diseases = new ArrayList<>(Collections.singletonList(disease));
//
//        // 开始分析的步骤开始 计入redis中
//        int step = 0;
//        addProcess(id, step++, "<p class='text_title'>基于国家标准，对" + drugName + "在治疗" + disease + "进行临床综合评价：</p>");
//
//        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
//        if (!GetSynonymUtil.judgeChinese(drugInfo)) {
//            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
//        }
//        EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName)), EvidenceMesh.class, synonymTable);
//        List<String> entryTerms = new ArrayList<>();
//        if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
//            entryTerms = evidenceMesh.getEntryTerms();
//        }
//        JSONObject instruction;
//        if (CollUtil.isNotEmpty(entryTerms)) {
//            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").in(entryTerms).and("enterpriseName").is(enterpriseName)), JSONObject.class, "instructions");
//        } else {
//            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName).and("enterpriseName").is(enterpriseName)), JSONObject.class, "instructions");
//        }
//
//        String content = "";
//        if (instruction != null) {
//            String pdf = instruction.getString("pdf_name");
//            if (StrUtil.isNotBlank(pdf)) {
//                String html = pdf.substring(0, pdf.length() - 3) + "html";
//                String htmlContent = "";
//                try {
//                    htmlContent = HttpUtil.downloadString("https://image.evimed.com/instructions\nmpa_html/" + html, "utf-8");
//                } catch (Exception e) {
//                   log.error(e.getMessage(), e);
//                }
//                content = HtmlUtil.cleanHtmlTag(htmlContent);
//            }
//        }
//        if (StrUtil.isNotBlank(content)) {
//            content = content.length() > 1000 ? content.substring(0, 1000) : content;
//        }
//
//        // 获取同义词
//        GetSynonyms(drugName, drugs, disease, diseases);
//
//        // 此处存储的key 与 value 的值在获取同义词接口出保存
//        String redis_key = "synonym:" + userId;
//        String synonym = RedisUtils.getStr(redis_key);
//        if (StrUtil.isNotBlank(synonym)) {
//            List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {
//            });
//            for (SynonymVo synonymVo : synonymVos) {
//                // 表明输入词有药
//                if (Integer.parseInt(synonymVo.getType()) == 1) {
//                    // 要所有已勾选的同义词
//                    drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
//                    // 排除所有反勾选的同义词
//                    drugs.removeAll(synonymVo.getExcludeSynonyms());
//                }
//
//                // 如果在研究疾病清单处自定义疾病  那么前一个页面中如果自定义了同义词就不再使用 否则需要使用自定义的同义词
//                if (Integer.parseInt(isCustom) == 0) {
//                    if (Integer.parseInt(synonymVo.getType()) == 3) {
//                        // 要所有已勾选的同义词
//                        diseases = new ArrayList<>(CollUtil.union(diseases, synonymVo.getSynonyms()));
//                        // 排除所有反勾选的同义词
//                        diseases.removeAll(synonymVo.getExcludeSynonyms());
//                    }
//                }
//            }
//        }
//
//        // 指南筛选
//        List<GuideVO> guideVOList = queryGuideByDrugAndDisease(drugs, drugName, diseases, disease);
//        // 存贮2条备用的指南
//        List<GuideVO> oldGuideVOList = new ArrayList<>();
//        if (CollUtil.isNotEmpty(guideVOList)) {
//            if (guideVOList.size() > 4) {
//                guideVOList = guideVOList.subList(0, 4);
//            }
//            guideVOList.sort((o1, o2) -> (int) (o2.getDateTs() - o1.getDateTs()));
//            if (guideVOList.size() > 2) {
//                oldGuideVOList = guideVOList;
//                guideVOList = guideVOList.subList(0, 2);
//                int size = oldGuideVOList.size();
//                oldGuideVOList = oldGuideVOList.subList(2, size);
//            }
//        }
//
//        // 文献筛选
//        List<Literature> literatureList = queryLiterature(drugName, drugs, disease, diseases);
//        if (literatureList.size() >= 2) {
//            literatureList = literatureList.subList(0, 2);
//        }
//
//        DrugInfoNew drugInfo1 = null;
//        if (Objects.nonNull(specifications) && StrUtil.isNotBlank(specifications)) {
//            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpriseName).and("specifications").is(specifications)), DrugInfoNew.class);
//        }
//        if (drugInfo1 == null) {
//            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
//        }
//
//        Map<String, Future<Boolean>> futureResult = new HashMap<>();
//        Map<String, JSONObject> gptAnalysisMap = new HashMap<>();
//        Map<GuideVO, JSONObject> guideEffectiveMap = new HashMap<>();
//        Map<GuideVO, JSONObject> guideOldEffectiveMap = new HashMap<>();
//        Map<Literature, JSONObject> literatureMap = new HashMap<>();
//        String innerContent = content;
//
//        parallelHandleGptAnalysis(drugName, disease, innerContent, enterpriseName, drugInfo1, guideVOList, oldGuideVOList, literatureList, futureResult, gptAnalysisMap, guideEffectiveMap, guideOldEffectiveMap, literatureMap);
//
//        // 1 药学特性部分
//        JSONObject pharmaceuticalCharacteristics = new JSONObject();
//        result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
//        pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
//        pharmaceuticalCharacteristics.put("table", new JSONArray().fluentAdd(new ArrayList<>(Arrays.asList("序号", "评价条目", "相关内容", "得分"))));
//        pharmaceuticalCharacteristics.put("score", 0);
//        pharmaceuticalCharacteristics.put("vscore", 0);
//
//        long begin = System.currentTimeMillis();
//        //GPT3.5
//        JSONObject pharmacy = new JSONObject();
//        if (Objects.nonNull(futureResult.get("pharmacy"))) {
//            try {
//                Boolean isSuccess = futureResult.get("pharmacy").get();
//                if (isSuccess) {
//                    pharmacy = gptAnalysisMap.get("pharmacy");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        addProcess(id, step++, "<b>1、药学特性</b>");
//        addProcess(id, step++, "主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
//        addProcess(id, step++, "（1）药理作用：");
//        assert drugInfo1 != null;
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getPharmacology()) ? drugInfo1.getPharmacology() : pharmacy.getString("pharmacology")));
//        addProcess(id, step++, "（2）体内过程：");
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getPharmacokinetics()) ? drugInfo1.getPharmacokinetics() : pharmacy.getString("disposition")));
//        addProcess(id, step++, "（3）药剂学与使用方法：");
//        if (StrUtil.isNotBlank(drugInfo1.getUsageAndDosage())) {
//            addProcess(id, step++, formatInfo(drugInfo1.getUsageAndDosage()));
//        } else {
//            addProcess(id, step++, formatInfo(pharmacy.getString("pharmaceutics")));
//            addProcess(id, step++, formatInfo(pharmacy.getString("usage")));
//        }
//        addProcess(id, step++, "（4）贮藏条件：");
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getStorage()) ? drugInfo1.getStorage() : pharmacy.getString("storage")));
//        addProcess(id, step++, "（5）药品有效期：");
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getIndate()) ? drugInfo1.getIndate() : pharmacy.getString("period")));
//
//
//        // 2.有效性部分
//        JSONObject effective = new JSONObject();
//        result.put("effectiveness", effective);
//        effective.put("effectiveness", "");
//        effective.put("score", 0);
//        effective.put("vscore", 0);
//
//        //2.1 适应症评分
//        JSONObject indicationEffective = new JSONObject();
//        if (Objects.nonNull(futureResult.get("indicationEffective"))) {
//            try {
//                Boolean isSuccess = futureResult.get("indicationEffective").get();
//                if (isSuccess) {
//                    indicationEffective = gptAnalysisMap.get("indicationEffective");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        addProcess(id, step++, "<b>2、有效性</b>");
//        addProcess(id, step++, "主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。");
//        addProcess(id, step++, "（1）适应证：");
//        // todo目前效果是 如果药品表中有适应症 需要显示出来 然后让gpt分析
//        if (StrUtil.isNotBlank(drugInfo1.getIndications())) {
//            addProcess(id, step++, formatInfo("适应症：" + drugInfo1.getIndications()));
//        }
//        addProcess(id, step++, formatInfo(indicationEffective.getString("process")));
//        effective.put("indication", indicationEffective.getString("process"));
//        effective.put("indicationScore", indicationEffective.getInteger("score"));
//
//
//        //2.2 分析指南
//        effective.put("guide", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
//        effective.put("guideAndLiteratureScore", 0);
////        effective.put("literatureScore", 0);
//        addProcess(id, step++, "（2）证据推荐详情：");
//        addProcess(id, step++, "&nbsp;&nbsp;&nbsp;① 指南推荐：");
//        step = filterGuideList(guideVOList, oldGuideVOList, effective, drugName, disease, id, step, futureResult, guideEffectiveMap, guideOldEffectiveMap);
//
//        effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
//        addProcess(id, step++, "&nbsp;&nbsp;&nbsp;② 文献推荐：");
//        step = filterLiteratureList(literatureList, effective, drugName, disease, id, step, futureResult, literatureMap);
//
//        //2.3 临床疗效评分
//        //GPT3.5
//        JSONObject clinicalEffective = new JSONObject();
//        if (Objects.nonNull(futureResult.get("clinicalEffective"))) {
//            try {
//                Boolean isSuccess = futureResult.get("clinicalEffective").get();
//                if (isSuccess) {
//                    clinicalEffective = gptAnalysisMap.get("clinicalEffective");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（3）临床疗效：");
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(clinicalEffective.getString("process")) ? clinicalEffective.getString("process") : effective.getString("effective")));
//        effective.put("effectiveness", StrUtil.isNotBlank(clinicalEffective.getString("process")) ? clinicalEffective.getString("process") : effective.getString("effective"));
//        effective.put("effectivenessScore", clinicalEffective.getInteger("score"));
//
//
//        int effectiveVscore = 0;
//        try {
//            effectiveVscore = indicationEffective.getInteger("score") + clinicalEffective.getInteger("score");
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//        // 记录总得分
//        effective.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其有效性进行评价：总分27分，主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。");
//        String effectiveFormatSorce = formatScore(new BigDecimal(effectiveVscore + effective.getFloat("guideAndLiteratureScore")).setScale(2, RoundingMode.HALF_UP).toString());
//        effective.put("vscore", effectiveFormatSorce);
//        effective.put("score", "有效性得分：" + effectiveFormatSorce + "分");
//
//        //3 安全性部分
//        addProcess(id, step++, "<b>3、安全性</b>");
//        addProcess(id, step++, "主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
////        JSONObject adrsJsonObject = new JSONObject();
////        if (Objects.nonNull(futureResult.get("adrsJsonObject"))) {
////            try {
////                Boolean isSuccess = futureResult.get("adrsJsonObject").get();
////                if (isSuccess) {
////                    adrsJsonObject = gptAnalysisMap.get("adrsJsonObject");
////                }
////            } catch (Exception e) {
////                log.error(e.getMessage(), e);
////            }
////        }
//
//        float safetyVScore = 0f;
////        try {
////            for(Map.Entry<String,Object> entry : adrsJsonObject.entrySet()){
////                try {
////                    safetyVScore += Float.parseFloat(entry.getValue().toString());
////                }catch (Exception e){
////                    log.error(e.getMessage(),e);
////                }
////            }
////        } catch (Exception e) {
////            log.error(e.getMessage(),e);
////        }
//
////        JSONObject adrsInfoObject = guideAdrsInfo_v2(drugName, content);
////        JSONObject adrsInfoObject = new JSONObject();
////        if (Objects.nonNull(futureResult.get("adrsInfoObject"))) {
////            try {
////                Boolean isSuccess = futureResult.get("adrsInfoObject").get();
////                if (isSuccess) {
////                    adrsInfoObject = gptAnalysisMap.get("adrsInfoObject");
////                }
////            } catch (Exception e) {
////                log.error(e.getMessage(), e);
////            }
////        }
//        JSONObject safety = new JSONObject();
////        String reason = "";
////        reason+= adrsJsonObject.getString("reason") + "</br>";//
////        safety.put("reason",reason);
//        safety.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其安全性进行评价：总分25分，主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
//        safety.put("details", new JSONObject());
//        safety.put("similarDrugsScore", "");
////        safety.put("adverseReactionsScore",adrsJsonObject.getString("score"));// todo 这里是干什么的
//        safety.put("specialPopulationsScore", "");
//        safety.put("pharmacovigilanceScore", "");
//        safety.put("table", new JSONArray().fluentAdd(Arrays.asList("序号", "评价条目", "相关内容", "得分")));
//        JSONObject adverseReactionAnalysis = new JSONObject();
//        if (Objects.nonNull(futureResult.get("adverseReactionAnalysis"))) {
//            try {
//                Boolean isSuccess = futureResult.get("adverseReactionAnalysis").get();
//                if (isSuccess) {
//                    adverseReactionAnalysis = gptAnalysisMap.get("adverseReactionAnalysis");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（1）不良反应：");
//        String mildAdverseReaction = adverseReactionAnalysis.getString("mildAdverseReaction").replace("[", "").replace("]", "");
//        String severeAdverseReaction = adverseReactionAnalysis.getString("severeAdverseReaction").replace("[", "").replace("]", "");
//        addProcess(id, step++, formatInfo("中度不良反应：" + mildAdverseReaction));
//        addProcess(id, step++, formatInfo("重度不良反应：" + severeAdverseReaction));
////        addProcess(id,step++,formatInfo(adrsInfoObject.getString("不良反应")));
//
//        JSONObject specialCrowdAnalysis = new JSONObject();
//        if (Objects.nonNull(futureResult.get("specialCrowdAnalysis"))) {
//            try {
//                Boolean isSuccess = futureResult.get("specialCrowdAnalysis").get();
//                if (isSuccess) {
//                    specialCrowdAnalysis = gptAnalysisMap.get("specialCrowdAnalysis");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（2）特殊人群：");
//        String pregnantWomen = drugInfo1.getPregnantWomen();
////        if (StrUtil.isNotBlank(specialCrowdAnalysis.getJSONObject("pregnantWomen").getString("result"))) {
////            specialCrowdAnalysis.put("pregnantWomen", specialCrowdAnalysis.getJSONObject("pregnantWomen").getString("result"));
////        }
//        addProcess(id, step++, formatInfo("孕妇及哺乳期妇女:" + (StrUtil.isNotBlank(pregnantWomen) ? pregnantWomen : specialCrowdAnalysis.getString("pregnantWomen"))));
//        String childrenMedicine = drugInfo1.getChildrenMedicine();
////        if (StrUtil.isNotBlank(specialCrowdAnalysis.getJSONObject("childrenMedicine").getString("result"))) {
////            specialCrowdAnalysis.put("childrenMedicine", specialCrowdAnalysis.getJSONObject("childrenMedicine").getString("result"));
////        }
//        addProcess(id, step++, formatInfo("儿童:" + (StrUtil.isNotBlank(childrenMedicine) ? childrenMedicine : specialCrowdAnalysis.getString("childrenMedicine"))));
//        String geriatricMedicine = drugInfo1.getGeriatricMedicine();
////        if (StrUtil.isNotBlank(specialCrowdAnalysis.getJSONObject("geriatricMedicine").getString("result"))) {
////            specialCrowdAnalysis.put("geriatricMedicine", specialCrowdAnalysis.getJSONObject("geriatricMedicine").getString("result"));
////        }
//        addProcess(id, step++, formatInfo("老年:" + (StrUtil.isNotBlank(geriatricMedicine) ? geriatricMedicine : specialCrowdAnalysis.getString("geriatricMedicine"))));
////        if (StrUtil.isNotBlank(specialCrowdAnalysis.getJSONObject("liverKidney").getString("result"))) {
////            specialCrowdAnalysis.put("liverKidney", specialCrowdAnalysis.getJSONObject("liverKidney").getString("result"));
////        }
//        addProcess(id, step++, formatInfo("肝肾功能异常者:" + specialCrowdAnalysis.getString("liverKidney")));
////            addProcess(id,step++,formatInfo(adrsInfoObject.getString("特殊人群")));
//        String drugInteraction = drugInfo1.getDrugInteraction();
//        JSONObject drugInteractionAnalysis = new JSONObject();
//        if (Objects.nonNull(futureResult.get("drugInteractionAnalysis"))) {
//            try {
//                Boolean isSuccess = futureResult.get("drugInteractionAnalysis").get();
//                if (isSuccess) {
//                    drugInteractionAnalysis = gptAnalysisMap.get("drugInteractionAnalysis");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（3）药物相互作用所致不良反应：");
//        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInteraction) ? drugInteraction : drugInteractionAnalysis.getString("drugInteraction")));
////            addProcess(id,step++,formatInfo(adrsInfoObject.getString("相互作用")));
//        JSONObject otherAdverseReactionAnalysis = new JSONObject();
//        if (Objects.nonNull(futureResult.get("otherAdverseReactionAnalysis"))) {
//            try {
//                Boolean isSuccess = futureResult.get("otherAdverseReactionAnalysis").get();
//                if (isSuccess) {
//                    otherAdverseReactionAnalysis = gptAnalysisMap.get("otherAdverseReactionAnalysis");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（4）其他：");
//        addProcess(id, step++, formatInfo(otherAdverseReactionAnalysis.getString("otherAdverseReaction")));
//
//
//        // 第五部分 药品综合评价之经济性
//        JSONObject economical = new JSONObject();
//        result.put("economical", economical);
//        try {
//            // 当前药品价格信息
//            SaveDrugPrice currDrugFee = this.mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId).and("drugName").is(drugName).and("manufacturer").is(enterpriseName)), SaveDrugPrice.class);
//            BigDecimal economicalVScore = new BigDecimal(0);
//            economical.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其经济性进行评价：总分10分，考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。");
//            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getMinAverageDailyCost() != null) {
//                try {
//                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, RoundingMode.HALF_UP);
//                    if (score.floatValue() > 3) {
//                        score = BigDecimal.valueOf(3);
//                    }
//                    economicalVScore = economicalVScore.add(score);
//                    economical.put("sameGericName", "评价方法：日均治疗费用最低的药品为" + score + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x3。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
//                } catch (Exception e) {
//                    log.error(e.getMessage(), e);
//                }
//            } else {
//                economicalVScore = economicalVScore.add(new BigDecimal(3));
//                economical.put("sameGericName", "待评价药品无同通用名药品，得3分。");
//            }
//
//            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getAlternativeMinAverageDailyCost() != null) {
//                try {
//                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getAlternativeMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, RoundingMode.HALF_UP);
//                    if (score.floatValue() > 7) {
//                        score = BigDecimal.valueOf(7);
//                    }
//                    economicalVScore = economicalVScore.add(score);
//                    economical.put("indicationReplace", "评价方法：日均治疗费用最低的药品为" + score + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x7。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
//                } catch (Exception e) {
//                    log.error(e.getMessage(), e);
//                }
//            } else {
//                economicalVScore = economicalVScore.add(new BigDecimal(0));
//                economical.put("indicationReplace", "待评价药品无主要适应证可替代药品，得0分。");
//            }
//            economicalVScore = economicalVScore.setScale(2, RoundingMode.HALF_UP);
//
//            String economicalFormatScore = formatScore(economicalVScore.toString());
//            economical.put("score", "经济性得分：" + economicalFormatScore + "分");
//            economical.put("vscore", economicalFormatScore);
//            addProcess(id, step++, "<b>4、经济性</b>");
//            addProcess(id, step++, "考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。根据您输入的内容，系统为您计算该药品在经济性上的评分结果为" + economicalFormatScore + "分。");
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//
//
//        // 5.其他属性部分
//        float otherVscore = 0f;
//        addProcess(id, step++, "<b>5、其他属性</b>");
//        addProcess(id, step++, "考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。");
//
//        // 5.1 国家医保纳入情况模块
//        //是否在医保目录
//        //boolean isInsurance = this.mongoTemplate.exists(new Query(Criteria.where("registered_name").is(drugName).and("medicine_enterprise").is(enterpirceName)),JSONObject.class,"medical_insurance_drugs");
//        boolean isInsurance = false;
//        String medicalInsurance = drugInfo1.getMedicalInsurance();
//        if (StringUtils.isNotBlank(medicalInsurance)) {
//            isInsurance = true;
//        }
//        addProcess(id, step++, "（1）国家医保纳入情况：");
//        addProcess(id, step++, isInsurance ? "已纳入医保" + (StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? "，" + drugInfo1.getMedicalInsurance() : "") : "未纳入医保");
//
//        // 医保得分
//        float isInsuranceScore = 1.00F;
//        if (isInsurance) {
//            boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo1.getPaymentScope());
//            if ("甲".equals(medicalInsurance)) {
//                if (paymentScopeStatus) {
//                    isInsuranceScore = 2.50F;
//                } else {
//                    isInsuranceScore = 3.00F;
//                }
//            } else {
//                if (paymentScopeStatus) {
//                    isInsuranceScore = 1.50F;
//                } else {
//                    isInsuranceScore = 2.00F;
//                }
//            }
//        }
//        otherVscore = isInsuranceScore;
//
//        // 5.2 国家基本药物目录纳入情况模块
//        //是否基本药物
//        //boolean isBase = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("essentialMedicines").is("是")),DrugAndPrice.class);
//        boolean isBase = false;
//        String essentialMedicines = drugInfo1.getEssentialMedicines();
//        if ("是".equals(essentialMedicines)) {
//            isBase = true;
//        }
//        addProcess(id, step++, "（2）国家基本药物目录纳入情况：");
//        addProcess(id, step++, isBase ? "已被纳入国家基本药物目录" : "未纳入国家基本药物目录");
//        int typeScore = 0;
//        String essentialType = drugInfo1.getEssentialType();
//        if (StringUtils.isNotBlank(essentialType)) {
//            typeScore = 1;
//        }
//        otherVscore = isBase ? otherVscore + 3 - typeScore : otherVscore + 1;
//
//        // 5.3 国家集中采购情况模块
//        //是否集中采购
//        //boolean isConcentrate = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("enterprise").is(enterpirceName)),JSONObject.class,"country_concentrate_drugs");
//        boolean isConcentrate = true;
//        String drugCollection = drugInfo1.getDrugCollection();
//        if ("本品非集采药品。".equals(drugCollection)) {
//            isConcentrate = false;
//        }
//        addProcess(id, step++, "（3）国家集中采购情况：");
//        addProcess(id, step++, isConcentrate ? "已纳入国家集中采购" : "未纳入国家集中采购");
//        otherVscore = isConcentrate ? otherVscore + 1 : otherVscore;
//
//        // 5.4  药品情况模块
//        // 药品情况的分析过程
//        String drugSituationString = "未知";
//        JSONObject guideDrugSituation = null;
//        //药品情况 GPT3.5
//        if (Objects.nonNull(futureResult.get("guideDrugSituation"))) {
//            try {
//                Boolean isSuccess = futureResult.get("guideDrugSituation").get();
//                if (isSuccess) {
//                    guideDrugSituation = gptAnalysisMap.get("guideDrugSituation");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//        addProcess(id, step++, "（4）药品情况：");
//           /*if (guideDrugSituation != null){
//            try {
//                otherVscore = otherVscore + guideDrugSituation.getFloat("score");
//                String info = guideDrugSituation.getString("info");
//                if (StringUtils.isNotBlank(info)){
//                    addProcess(id,step++, formatInfo(info));
//                    drugSituationString = info;
//                }else {
//                    addProcess(id,step++,"未知");
//                }
//            } catch (Exception e) {
//                addProcess(id,step++,"未知");
//            }
//        }else {*/
//        guideDrugSituation = new JSONObject();
//        String originalDrug = drugInfo1.getOriginalDrug();
//        String referenceDrug = drugInfo1.getReferenceDrug();
//        String consistencyDrug = drugInfo1.getConsistencyDrug();
//        if (CommonConstants.YES.equals(originalDrug)) {
//            otherVscore = otherVscore + 1F;
//            addProcess(id, step++, "原研药品");
//            drugSituationString = "原研药品";
//            guideDrugSituation.put("score", 1);
//        }
//        if (!CommonConstants.YES.equals(originalDrug) && "本品为仿制药参比药品。".equals(referenceDrug)) {
//            otherVscore = otherVscore + 1F;
//            addProcess(id, step++, "仿制药参比药品");
//            drugSituationString = "仿制药参比药品";
//            guideDrugSituation.put("score", 1);
//        }
//        if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && CommonConstants.YES.equals(consistencyDrug)) {
//            otherVscore = otherVscore + 0.5F;
//            addProcess(id, step++, "一致性评价药品");
//            drugSituationString = "一致性评价药品";
//            guideDrugSituation.put("score", 0.5);
//        }
//        if (!CommonConstants.YES.equals(originalDrug) && !"本品为仿制药参比药品。".equals(referenceDrug) && !CommonConstants.YES.equals(consistencyDrug)) {
//            addProcess(id, step++, "未知");
//            guideDrugSituation.put("score", 0);
//        }
////        }
//
//        // 5.5 生产企业情况模块
//        String enterpriseString = "未知";
//        //生产企业情况
//        JSONObject guideEnterprise = new JSONObject();
//        if (Objects.nonNull(futureResult.get("guideEnterprise"))) {
//            try {
//                Boolean isSuccess = futureResult.get("guideEnterprise").get();
//                if (isSuccess) {
//                    guideEnterprise = gptAnalysisMap.get("guideEnterprise");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        addProcess(id, step++, "（5）生产企业情况：");
//        if (guideEnterprise != null) {
//            try {
//                otherVscore = otherVscore + guideEnterprise.getFloat("score");
//                String info = guideEnterprise.getString("info");
//                if (StringUtils.isNotBlank(info)) {
//                    addProcess(id, step++, formatInfo(info));
//                    enterpriseString = info;
//                } else {
//                    addProcess(id, step++, "未知");
//                }
//            } catch (Exception e) {
//                addProcess(id, step++, "未知");
//            }
//        } else {
//            addProcess(id, step++, "未知");
//        }
//
//        // 5.6 全球使用情况模块
//        //全球使用情况
//        String countryString = "未知";
//        //GPT3.5
//        JSONObject guideCountry = new JSONObject();
//        if (Objects.nonNull(futureResult.get("guideCountry"))) {
//            try {
//                Boolean isSuccess = futureResult.get("guideCountry").get();
//                if (isSuccess) {
//                    guideCountry = gptAnalysisMap.get("guideCountry");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        addProcess(id, step++, "（6）全球使用情况：");
//        if (guideCountry != null) {
//            try {
//                otherVscore = otherVscore + guideCountry.getFloat("score");
//                String info = guideCountry.getString("info1");
//                if (StringUtils.isNotBlank(info)) {
//                    addProcess(id, step++, formatInfo(info));
//                    countryString = info;
//                } else {
//                    addProcess(id, step++, "未知");
//                }
//            } catch (Exception e) {
//                addProcess(id, step++, "未知");
//            }
//        } else {
//            addProcess(id, step++, "未知");
//        }
//
//        log.info("gpt分析总时长{}", System.currentTimeMillis() - begin);
//
//
//        // 单独计算得分的操作放在最后边  //todo 单独计算得分的操作放在最后边
//        JSONObject pharmacyScore = new JSONObject();
//        if (Objects.nonNull(futureResult.get("pharmacyScore"))) {
//            try {
//                Boolean isSuccess = futureResult.get("pharmacyScore").get();
//                if (isSuccess) {
//                    pharmacyScore = gptAnalysisMap.get("pharmacyScore");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        float usageAndDosageScore = 0f;
//        try {
//            usageAndDosageScore = Float.parseFloat(pharmacyScore.getString("usageAndDosageScore"));
//        } catch (Exception e) {
//            usageAndDosageScore = 0f;
//        }
//
//        if (usageAndDosageScore > 12) {
//            pharmacyScore.put("usageAndDosageScore", 12);
//        }
//        try {
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", StrUtil.isNotBlank(drugInfo1.getPharmacology()) ? drugInfo1.getPharmacology() : pharmacy.getString("pharmacology"), pharmacyScore.getString("pharmacologyScore"))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", StrUtil.isNotBlank(drugInfo1.getPharmacokinetics()) ? drugInfo1.getPharmacokinetics() : pharmacy.getString("disposition"), pharmacyScore.getString("pharmacokineticsScore"))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", StrUtil.isNotBlank(drugInfo1.getUsageAndDosage()) ? drugInfo1.getUsageAndDosage() : pharmacy.getString("pharmaceutics") + "</br>" + pharmacy.getString("usage"), usageAndDosageScore)));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", StrUtil.isNotBlank(drugInfo1.getStorage()) ? drugInfo1.getStorage() : pharmacy.getString("storage"), pharmacyScore.getString("storageScore"))));
//            pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", StrUtil.isNotBlank(drugInfo1.getIndate()) ? drugInfo1.getIndate() : pharmacy.getString("period"), pharmacyScore.getString("indateScore"))));
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//
//        float pharmaceuticalScore = 0f;
//        // 计算药学特性部分总得分
//        for (Map.Entry<String, Object> entry : pharmacyScore.entrySet()) {
//            if (entry.getValue() != null) {
//                try {
//                    pharmaceuticalScore += Float.parseFloat(entry.getValue().toString());
//                } catch (Exception e) {
//                    pharmaceuticalScore += 0f;
//                }
//            }
//        }
//        String pharmacyFormatScore = formatScore(new BigDecimal(pharmaceuticalScore).setScale(2, RoundingMode.HALF_UP).toString());
//        pharmaceuticalCharacteristics.put("score", "药学特性得分：" + pharmacyFormatScore + "分");
//        pharmaceuticalCharacteristics.put("vscore", pharmacyFormatScore);
//
//
//        JSONObject specialCrowdScore = new JSONObject();
//        if (Objects.nonNull(futureResult.get("specialCrowdScore"))) {
//            try {
//                Boolean isSuccess = futureResult.get("specialCrowdScore").get();
//                if (isSuccess) {
//                    specialCrowdScore = gptAnalysisMap.get("specialCrowdScore");
//                }
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        float mildAdverseReactionScore = 0f;
//        try {
//            mildAdverseReactionScore = Float.parseFloat(adverseReactionAnalysis.getString("mildAdverseReactionScore"));
//            mildAdverseReactionScore = Math.min(mildAdverseReactionScore, 3); // 这里有时候打分总是超过3分
//            if (StrUtil.isNotBlank(adverseReactionAnalysis.getString("mildAdverseReaction"))) {
//                mildAdverseReactionScore = mildAdverseReactionScore == 0f ? 3f : mildAdverseReactionScore;
//            }
//        } catch (Exception e) {
//            mildAdverseReactionScore = 0f;
//        }
//
//        float severeAdverseReactionScore = 0f;
//        try {
//            severeAdverseReactionScore = Float.parseFloat(adverseReactionAnalysis.getString("severeAdverseReactionScore"));
//            severeAdverseReactionScore = Math.min(severeAdverseReactionScore, 5); // 这里有时候打分总是超过5分
//            if (StrUtil.isNotBlank(adverseReactionAnalysis.getString("severeAdverseReaction"))) {
//                severeAdverseReactionScore = severeAdverseReactionScore == 0f ? 5f : severeAdverseReactionScore;
//            }
//        } catch (Exception e) {
//            severeAdverseReactionScore = 0f;
//        }
//
//        String s7 = formatScore(new BigDecimal(mildAdverseReactionScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("1", "中度不良反应", adverseReactionAnalysis.getString("mildAdverseReaction"), s7));
//        safetyVScore += mildAdverseReactionScore;
//
//        String s8 = formatScore(new BigDecimal(severeAdverseReactionScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("2", "重度不良反应", adverseReactionAnalysis.getString("severeAdverseReaction"), s8));
//        safetyVScore += severeAdverseReactionScore;
//
//        // 记录特殊人群总得分
//        float specialCrowdScoreCalculate = 0f;
//        float pregnantAndLactating = 0f;
//        try {
//            pregnantAndLactating = Float.parseFloat(specialCrowdScore.getString("pregnantScore")) + Float.parseFloat(specialCrowdScore.getString("lactatingScore"));
//        } catch (Exception e) {
//            pregnantAndLactating = 0f;
//        }
//        String s0 = formatScore(new BigDecimal(pregnantAndLactating).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("3", "孕妇及哺乳期妇女", (StrUtil.isNotBlank(pregnantWomen) ? StrUtil.replace(pregnantWomen, "<br>", "") : specialCrowdAnalysis.getString("pregnantWomen")), s0));
//        safetyVScore += pregnantAndLactating;
//        specialCrowdScoreCalculate += pregnantAndLactating;
//
//
//        float childrenScore = 0f;
//        try {
//            childrenScore = Float.parseFloat(specialCrowdScore.getString("childrenScore"));
//        } catch (Exception e) {
//            childrenScore = 0f;
//        }
//        String s1 = formatScore(new BigDecimal(childrenScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("4", "儿童", (StrUtil.isNotBlank(childrenMedicine) ? StrUtil.replace(childrenMedicine, "<br>", "") : specialCrowdAnalysis.getString("childrenMedicine")), s1));
//        safetyVScore += childrenScore;
//        specialCrowdScoreCalculate += childrenScore;
//
//        float geriatricScore = 0f;
//        try {
//            geriatricScore = Float.parseFloat(specialCrowdScore.getString("geriatricScore"));
//        } catch (Exception e) {
//            geriatricScore = 0f;
//        }
//        String s2 = formatScore(new BigDecimal(geriatricScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("5", "老人", (StrUtil.isNotBlank(geriatricMedicine) ? StrUtil.replace(geriatricMedicine, "<br>", "") : specialCrowdAnalysis.getString("geriatricMedicine")), s2));
//        safetyVScore += geriatricScore;
//        specialCrowdScoreCalculate += geriatricScore;
//
//
//        float liverAndKidney = 0f;
//        try {
//            liverAndKidney = Float.parseFloat(specialCrowdScore.getString("liverScore")) + Float.parseFloat(specialCrowdScore.getString("kidneyScore"));
//        } catch (Exception e) {
//            liverAndKidney = 0f;
//        }
//        String s3 = formatScore(new BigDecimal(liverAndKidney).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("6", "肝肾功能异常者", specialCrowdAnalysis.getString("liverKidney"), s3));
//        safetyVScore += liverAndKidney;
//        specialCrowdScoreCalculate += liverAndKidney;
//
//        float drugInteractionScore = 0f;
//        try {
//            drugInteractionScore = Float.parseFloat(drugInteractionAnalysis.getString("drugInteractionScore"));
//        } catch (Exception e) {
//            drugInteractionScore = 0f;
//        }
//        String s4 = formatScore(new BigDecimal(drugInteractionScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("7", "相互作用", StrUtil.isNotBlank(drugInteraction) ? drugInteraction : drugInteractionAnalysis.getString("drugInteraction"), s4));
//        safetyVScore += drugInteractionScore;
//
//
//        float otherAdverseReactionScore = 0f;
//        try {
//            otherAdverseReactionScore = Float.parseFloat(otherAdverseReactionAnalysis.getString("otherAdverseReactionScore"));
//        } catch (Exception e) {
//            otherAdverseReactionScore = 0f;
//        }
//        String s5 = formatScore(new BigDecimal(otherAdverseReactionScore).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.getJSONArray("table").add(Arrays.asList("8", "其他不良反应", otherAdverseReactionAnalysis.getString("otherAdverseReaction"), s5));
//        safetyVScore += otherAdverseReactionScore;
//
//        String safetyFormatSorce = formatScore(new BigDecimal(safetyVScore).setScale(2, RoundingMode.HALF_UP).toString());
//        String specialCrowdScoreTotal = formatScore(new BigDecimal(specialCrowdScoreCalculate).setScale(2, RoundingMode.HALF_UP).toString());
//        safety.put("specialCrowdScoreTotal", specialCrowdScoreTotal);
//        safety.put("score", "安全性得分：" + safetyFormatSorce + "分");
//        safety.put("vscore", safetyFormatSorce);
//        result.put("safety", safety);
//        result.put("time", DateUtil.formatDateTime(new Date()));
//
//
//        // 第六部分 药品综合评价之其他属性
//        JSONObject otherAttributes = new JSONObject();
//        result.put("otherAttributes", otherAttributes);
//        String otherFormatScore = formatScore(new BigDecimal(otherVscore).setScale(2, RoundingMode.HALF_UP).toString());
//        otherAttributes.put("score", "其他属性得分：" + otherFormatScore + "分");
//        otherAttributes.put("vscore", otherFormatScore);
//        /*DrugAndPrice drugAndPrice;
//        if(drugNameWords != null && CollectionUtil.isNotEmpty(drugNameWords.getJSONArray("words"))){
//            drugAndPrice = this.mongoTemplate.findOne(new Query(Criteria.where("productName").in(drugNameWords.getJSONArray("words"))),DrugAndPrice.class);
//        }else {
//            drugAndPrice = this.mongoTemplate.findOne(new Query(Criteria.where("productName").is(drugName)),DrugAndPrice.class);
//        }*/
//        otherAttributes.put("paymentLimits", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
//        otherAttributes.put("essentialMedicines", isBase);
//        otherAttributes.put("reimbursementList", isInsurance);
//        otherAttributes.put("reimbursement", StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? drugInfo1.getMedicalInsurance() + "类" : "");
//        //支付限制
//        otherAttributes.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
//        otherAttributes.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其他属性进行评价：总分10分，考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。");
//        //是否列为国家集中采购药品
//        otherAttributes.put("procurementOfDrugs", isConcentrate);
//        //国家基本药物得分
//        otherAttributes.put("essentialMedicinesScore", isBase ? 3 - typeScore : 1);
//        //有无△要求
//        otherAttributes.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
//        //国家医保目录得分
//        otherAttributes.put("reimbursementListScore", formatScore(String.valueOf(isInsuranceScore)));
//        //国家集中采购药品得分
//        otherAttributes.put("procurementOfDrugsScore", isConcentrate ? 1 : 0);
//        //原研/参比/一致性评价
//        otherAttributes.put("guideDrugSituation", drugSituationString);
//        otherAttributes.put("guideDrugSituationScore", formatScore(String.valueOf(guideDrugSituation.getFloat("score"))));
//        //生产企业状态
//        otherAttributes.put("guideEnterprise", enterpriseString);
//        otherAttributes.put("guideEnterpriseScore", guideEnterprise != null ? formatScore(String.valueOf(guideEnterprise.getFloat("score"))) : 0);
//        //全球使用情况
//        otherAttributes.put("guideCountry", countryString);
//        otherAttributes.put("guideCountryScore", guideCountry != null ? formatScore(String.valueOf(guideCountry.getFloat("score"))) : 0);
//        otherAttributes.put("table", new JSONArray());
//        otherAttributes.getJSONArray("table").add(Arrays.asList("药品名称", "原研/参比/一致性评价", "生产厂家", "生产企业状态", "全球使用情况"));
//        otherAttributes.getJSONArray("table").add(Arrays.asList(drugName, drugSituationString, enterpriseName, enterpriseString, countryString));
//        result.put("otherAttributes", otherAttributes);
//
//        try {
//            JSONObject overallSummary = new JSONObject();
//            overallSummary.put("targetDrug", drugName);
//            BigDecimal vscore = new BigDecimal("0");
//            try {
//                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("safety").getFloat("vscore")));
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            try {
//                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("pharmaceuticalCharacteristics").getFloat("vscore")));
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            try {
//                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("effectiveness").getFloat("vscore")));
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            try {
//                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("otherAttributes").getFloat("vscore")));
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            try {
//                vscore = vscore.add(BigDecimal.valueOf(result.getJSONObject("economical").getFloat("vscore")));
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            result.put("overallSummary", overallSummary);
//            overallSummary.put("comprehensiveScore", vscore.setScale(2, RoundingMode.HALF_UP));
//            overallSummary.put("dimensionDiagram", new JSONArray());
//            overallSummary.put("score", vscore.setScale(2, RoundingMode.HALF_UP));
//            BigDecimal bigDecimal = vscore.setScale(2, RoundingMode.HALF_UP);
//            float value = bigDecimal.floatValue();
//            String status;
//            if (value > 70) {
//                status = "强推荐";
//            } else if (value < 60) {
//                status = "不推荐";
//            } else {
//                status = "弱推荐";
//            }
//            overallSummary.put("recommendation", "临床上治疗" + disease + "时，" + status + "使用" + drugName + "。");
//            overallSummary.put("status", status);
//
//            JSONObject jsonObject1 = new JSONObject();
//            jsonObject1.put("max", 25);
//            jsonObject1.put("name", "安全性");
//            jsonObject1.put("value", result.getJSONObject("safety").getString("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
//            JSONObject jsonObject2 = new JSONObject();
//            jsonObject2.put("max", 27);
//            jsonObject2.put("name", "有效性");
//            jsonObject2.put("value", result.getJSONObject("effectiveness").getString("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
//            JSONObject jsonObject3 = new JSONObject();
//            jsonObject3.put("max", 28);
//            jsonObject3.put("name", "药学特性");
//            jsonObject3.put("value", result.getJSONObject("pharmaceuticalCharacteristics").getString("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
//            JSONObject jsonObject4 = new JSONObject();
//            jsonObject4.put("max", 10);
//            jsonObject4.put("name", "其他属性");
//            jsonObject4.put("value", result.getJSONObject("otherAttributes").getString("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
//            JSONObject jsonObject5 = new JSONObject();
//            jsonObject5.put("max", 10);
//            jsonObject5.put("name", "经济性");
//            jsonObject5.put("value", result.getJSONObject("economical").getString("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//
//        String uuid = UUID.randomUUID().toString();
//        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
//        result.put("id", uuid);
//        result.put("_id", uuid);
//        result.put("drugName", drugName);
//        result.put("disease", disease);
//        StringBuilder drugInfoSB = new StringBuilder();
//        if (StrUtil.isNotBlank(drugName)) {
//            drugInfoSB.append(drugName).append("-");
//        }
//        if (StrUtil.isNotBlank(specifications)) {
//            drugInfoSB.append(specifications).append("-");
//        }
//        if (StrUtil.isNotBlank(enterpriseName)) {
//            drugInfoSB.append(enterpriseName);
//        }
//        drugInfo = drugInfoSB.toString();
//        result.put("drugInfo", drugInfo);
//        this.mongoTemplate.insert(result, "drug_analyze_data");
//
//        log.info(result.toJSONString());
//        addProcess(id, step, "-END-");
//        log.info("剩余代码执行花费时长{}", System.currentTimeMillis() - begin);
//        return result;
//        */
//    }


    /**
     * 翻译
     *
     * @param s
     * @return
     */
    @Override
    public String getTransDeepl(String s) {
        // 优先判断act标准词表中是否有当前词的对应翻译
        if (GetSynonymUtil.judgeChinese(s)) {
            ATCDrugs atcDrugs = MongoUtil.mongo.findOne(new Query(Criteria.where("chineseName").is(s.toLowerCase())), ATCDrugs.class);
            if (atcDrugs != null && StringUtils.isNotBlank(atcDrugs.getEnglishName())) {
                return atcDrugs.getEnglishName();
            }
        } else {
            ATCDrugs atcDrugs = MongoUtil.mongo.findOne(new Query(Criteria.where("englishName").is(s.toLowerCase())), ATCDrugs.class);
            if (atcDrugs != null && StringUtils.isNotBlank(atcDrugs.getChineseName())) {
                return atcDrugs.getChineseName();
            }
        }
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", s);
        return fineScreenFeign.deepl(jsonObject);

    }

    private List<String> getSynonym(String str) {
        JSONObject result = fineScreenFeign.getSynonyms(str);
        List<String> ans = new ArrayList<>();
        if (result != null) {
            result = result.getJSONObject("data");
            if (CollectionUtil.isNotEmpty(result.getJSONArray("synonym"))) {
                JSONArray synonym = result.getJSONArray("synonym");
                for (JSONObject jsonObject : synonym.toJavaList(JSONObject.class)) {
                    ans.add(jsonObject.getString("name"));
                }
            }
        }
        return ans;
    }


    @Override
    public void GetSynonyms(String drugName, List<String> drugs, String disease, List<String> diseases) {
        Map<String, String> drugTransMap = new HashMap<>();
        drugTransMap.put(drugName, getTransDeepl(drugName));
        List<DrugInfoNew> drugInfos = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugs)), DrugInfoNew.class);
        List<String> drugsCopy = new ArrayList<>();
        drugInfos.forEach(DrugInfoNew -> {
            if (StrUtil.isNotBlank(DrugInfoNew.getDrugEn())) {
                drugsCopy.add(DrugInfoNew.getDrugEn());
            }
            if (StrUtil.isNotBlank(DrugInfoNew.getDrugZh())) {
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
            // 翻译词的同义词
            if (StrUtil.isNotBlank(drugTransMap.get(drugName))) {
                drugs.add(drugTransMap.get(drugName));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(drugTransMap.get(drugName));
                drugs.addAll(synonymTrans);
            }
        }
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        Map<String, String> diseaseTransMap = new HashMap<>();
        diseaseTransMap.put(disease, getTransDeepl(disease));
        // 获取完同义词
        String defaultPrompt = CommonPromptEnum.DISEASE_SPLIT.getDefaultPrompt();
//        String gpt = getGpt(defaultPrompt + disease, null);
//        diseases.add(gpt);
        boolean isUseTransDisease = GetSynonymUtil.getSynonym(disease, diseases, diseases);
//        boolean isUseTransDiseasex = GetSynonymUtil.getSynonym(gpt, diseases, diseases);
        if (!isUseTransDisease) {
            // 翻译词的同义词
            if (StrUtil.isNotBlank(diseaseTransMap.get(disease))) {
                diseases.add(diseaseTransMap.get(disease));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(diseaseTransMap.get(disease));
                diseases.addAll(synonymTrans);
            }
        }

        diseases = diseases.stream().distinct().collect(Collectors.toList());
    }

//    private int filterLiteratureList(List<Literature> literatureList, JSONObject effective, String drugName, String disease, String id, int step, Map<String, Future<Boolean>> futureResult, Map<Literature, JSONObject> literatureMap) {
//        List<String> literatureTitle = new ArrayList<>();
//        if (!CollUtil.isEmpty(literatureList)) {
//            // 等待异步执行完毕
//            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
//                if (StrUtil.startWith(futureEntry.getKey(), "literature")) {
//                    Future<Boolean> literatureResult = futureEntry.getValue();
//                    try {
//                        literatureResult.get();
//                    } catch (Exception e) {
//                        log.error(e.getMessage(), e);
//                    }
//                }
//            }
//
//            if (CollUtil.isNotEmpty(literatureMap)) {
//                for (Map.Entry<Literature, JSONObject> literatureJSONObjectEntry : literatureMap.entrySet()) {
//                    Literature literature = literatureJSONObjectEntry.getKey();
//                    JSONObject literatureAnalysis = literatureJSONObjectEntry.getValue();
//                    if (!StrUtil.isNumeric(literatureAnalysis.getString("score"))
//                            || StrUtil.isBlank(literatureAnalysis.getString("summary"))
//                            || CollUtil.contains(literatureTitle, literature.getTitle())) {
//                        continue;
//                    }
//
//                    // 因为文献的名字存在相同 但是 文献id不同的情况 去重
//                    literatureTitle.add(literature.getTitle());
//                    addProcess(id, step++, "《" + literature.getTitle() + "》");
//
//                    literatureAnalysis.put("title", literature.getTitle());
//                    literatureAnalysis.put("zdz", literature.getJournal());
//                    literatureAnalysis.put("fbdate", literature.getYear());
//
//                    if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < literatureAnalysis.getInteger("score")) {
//                        effective.put("reason", literatureAnalysis.getString("reason"));
//                        effective.put("guideAndLiteratureScore", literatureAnalysis.getString("score"));
//                    }
//
//                    JSONArray jsonArray1 = new JSONArray();
//                    jsonArray1.add(literature.getTitle());
//                    jsonArray1.add(literature.getJournal());
//                    jsonArray1.add(literature.getYear());
//                    jsonArray1.add(literatureAnalysis.getString("summary"));
//                    effective.getJSONArray("literature").add(jsonArray1);
//                }
//            }
//        } else {
//            addProcess(id, step++, "&nbsp;暂时无法找到该药物治疗此疾病的相关文献推荐");
//        }
//        return step;
//    }
//
//    private int filterGuideList(List<GuideVO> guideVOList, List<GuideVO> oldGuideVOList, JSONObject effective, String drugName, String disease, String id, int step, Map<String, Future<Boolean>> futureResult, Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap) {
//        int guideIndex = 0;
//
//        if (CollUtil.isEmpty(guideVOList)) {
//            addProcess(id, step++, "&nbsp;暂时无法找到该药物治疗此疾病的相关指南推荐");
//        } else {
//            // 等待异步执行完毕
//            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
//                if (StrUtil.startWith(futureEntry.getKey(), "guideEffective")) {
//                    Future<Boolean> guideResult = futureEntry.getValue();
//                    try {
//                        guideResult.get();
//                    } catch (Exception e) {
//                        log.error(e.getMessage(), e);
//                    }
//                }
//            }
//
//            if (CollUtil.isNotEmpty(guideEffectiveMap)) {
//                for (Map.Entry<GuideVO, JSONObject> guideVOJSONObjectEntry : guideEffectiveMap.entrySet()) {
//                    GuideVO searchHit = guideVOJSONObjectEntry.getKey();
//                    JSONObject guideEffective = guideVOJSONObjectEntry.getValue();
//                    if ((Objects.nonNull(guideEffective.getBoolean("error")) && (guideEffective.getBoolean("error")))
//                            || !StrUtil.isNumeric(guideEffective.getString("score"))
//                            || (StrUtil.isBlank(guideEffective.getString("summary")))
//                    ) {
//                        guideIndex++;
//                        continue;
//                    }
//
//                    addProcess(id, step++, "《" + searchHit.getTitle() + "》");
//
//                    guideEffective.put("title", searchHit.getTitle());
//                    guideEffective.put("zdz", searchHit.getZdz());
//                    guideEffective.put("fbdate", searchHit.getFbdate());
//
//                    if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < guideEffective.getInteger("score")) {
//                        effective.put("reason", guideEffective.getString("reason"));
//                        effective.put("guideAndLiteratureScore", guideEffective.getString("score"));
//                        effective.put("effective", guideEffective.get("effective"));
//                    }
//
//                    JSONArray jsonArray1 = new JSONArray();
//                    jsonArray1.add(searchHit.getTitle());
//                    jsonArray1.add(searchHit.getZdz());
//                    jsonArray1.add(searchHit.getFbdate());
//                    jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
//                    jsonArray1.add(guideEffective.getString("summary"));
//                    effective.getJSONArray("guide").add(jsonArray1);
//                }
//            }
//        }
//
//        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap)) {
//            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult.entrySet()) {
//                if (StrUtil.startWith(futureEntry.getKey(), "guideOldEffective")) {
//                    Future<Boolean> guideResult = futureEntry.getValue();
//                    try {
//                        guideResult.get();
//                    } catch (Exception e) {
//                        log.error(e.getMessage(), e);
//                    }
//                }
//            }
//
//            int size = guideOldEffectiveMap.size();
//            do {
//                List<GuideVO> guideVOS = new ArrayList<>(guideOldEffectiveMap.keySet());
//                GuideVO searchHit = guideVOS.get(size - 1);
//                JSONObject guideEffective = guideOldEffectiveMap.get(searchHit);
//                if ((Objects.nonNull(guideEffective.getBoolean("error")) && (guideEffective.getBoolean("error")))
//                        || !StrUtil.isNumeric(guideEffective.getString("score"))
//                        || (StrUtil.isBlank(guideEffective.getString("summary")))
//                ) {
//                    continue;
//                }
//
//                addProcess(id, step++, "《" + searchHit.getTitle() + "》");
//
//                guideEffective.put("title", searchHit.getTitle());
//                guideEffective.put("zdz", searchHit.getZdz());
//                guideEffective.put("fbdate", searchHit.getFbdate());
//
//                if (effective.getInteger("guideAndLiteratureScore") == 0 || effective.getInteger("guideAndLiteratureScore") < guideEffective.getInteger("score")) {
//                    effective.put("reason", guideEffective.getString("reason"));
//                    effective.put("guideAndLiteratureScore", guideEffective.getString("score"));
//                    effective.put("effective", guideEffective.get("effective"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(searchHit.getTitle());
//                jsonArray1.add(searchHit.getZdz());
//                jsonArray1.add(searchHit.getFbdate());
//                jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
//                jsonArray1.add(guideEffective.getString("summary"));
//                effective.getJSONArray("guide").add(jsonArray1);
//            } while (--guideIndex > 0 && --size > 0);
//        }
//        return step;
//    }

    private void filterGuideListApp(List<GuideVO> guideVOList, List<GuideVO> oldGuideVOList, JSONObject effective, String drugName, String disease, String id) {
        int guideIndex = 0;
        Map<GuideVO, JSONObject> guideEffectiveMap = new HashMap<>();
        List<Future<Boolean>> futureList = new ArrayList<>();
        Map<GuideVO, JSONObject> guideOldEffectiveMap = new HashMap<>();
        List<Future<Boolean>> futureOldList = new ArrayList<>();

        if (CollUtil.isNotEmpty(guideVOList)) {
            for (GuideVO searchHit : guideVOList) {
                Future<Boolean> guideEffectiveResult = guideAnalysisThreadPool.submit(() -> {
                    JSONObject guideEffective = new JSONObject();
                    try {
                        log.info("分析的指南是{}", searchHit.getTitle());
                        long begin = System.currentTimeMillis();
                        guideEffective = guideEffective(searchHit.getTitle(), drugName, disease, StrUtil.isNotBlank(searchHit.getPdf_txt()) ? searchHit.getPdf_txt().length() > 1500 ? searchHit.getPdf_txt().substring(0, 1500) : searchHit.getPdf_txt() : " ");
                        log.info("指南{}gpt分析花费了{}时间", searchHit.getTitle(), System.currentTimeMillis() - begin);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guideEffective.getString("score") == null) {
                            guideEffective.put("score", 0);
                        }
                        if (guideEffective.getString("reason") == null) {
                            guideEffective.put("reason", "");
                        }
                        if (guideEffective.getString("summary") == null) {
                            guideEffective.put("summary", "");
                        }
                        if (guideEffective.getString("level") == null) {
                            guideEffective.put("level", "");
                        }
                        if (guideEffective.getString("advantage") == null) {
                            guideEffective.put("advantage", "");
                        }
                        if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                            guideEffective.put("score", guideEffective.getInteger("score") + 4);
                        }
                    }
                    guideEffectiveMap.put(searchHit, guideEffective);
                    return true;
                });

                futureList.add(guideEffectiveResult);
            }
        }

        if (CollUtil.isNotEmpty(oldGuideVOList)) {
            for (GuideVO searchHit : oldGuideVOList) {
                Future<Boolean> guideEffectiveResult = guideAnalysisThreadPool.submit(() -> {
                    JSONObject guideEffective = new JSONObject();
                    try {
                        log.info("分析的指南是{}", searchHit.getTitle());
                        long begin = System.currentTimeMillis();
                        guideEffective = guideEffective(searchHit.getTitle(), drugName, disease, StrUtil.isNotBlank(searchHit.getPdf_txt()) ? searchHit.getPdf_txt().length() > 1500 ? searchHit.getPdf_txt().substring(0, 1500) : searchHit.getPdf_txt() : " ");
                        log.info("指南{}gpt分析花费了{}时间", searchHit.getTitle(), System.currentTimeMillis() - begin);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guideEffective.getString("score") == null) {
                            guideEffective.put("score", 0);
                        }
                        if (guideEffective.getString("reason") == null) {
                            guideEffective.put("reason", "");
                        }
                        if (guideEffective.getString("summary") == null) {
                            guideEffective.put("summary", "");
                        }
                        if (guideEffective.getString("level") == null) {
                            guideEffective.put("level", "");
                        }
                        if (guideEffective.getString("advantage") == null) {
                            guideEffective.put("advantage", "");
                        }
                        if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                            guideEffective.put("score", guideEffective.getInteger("score") + 4);
                        }
                    }
                    guideOldEffectiveMap.put(searchHit, guideEffective);
                    return true;
                });

                futureOldList.add(guideEffectiveResult);
            }
        }

        for (Future<Boolean> booleanFuture : futureList) {
            try {
                Boolean isGetResult = booleanFuture.get();
                if (!isGetResult) {
                    log.info("多线程中指南分析失败");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        if (CollUtil.isNotEmpty(guideEffectiveMap)) {
            for (Map.Entry<GuideVO, JSONObject> guideVOJSONObjectEntry : guideEffectiveMap.entrySet()) {
                GuideVO searchHit = guideVOJSONObjectEntry.getKey();
                JSONObject guideEffective = guideVOJSONObjectEntry.getValue();
                if ((ObjectUtil.isNotNull(guideEffective.getBoolean("error")) && guideEffective.getBoolean("error"))
                        || !StrUtil.isNumeric(guideEffective.getString("score"))
                        || (StrUtil.isBlank(guideEffective.getString("summary"))
                )
                ) {
                    guideIndex++;
                    continue;
                }

                guideEffective.put("title", searchHit.getTitle());
                guideEffective.put("zdz", searchHit.getZdz());
                guideEffective.put("fbdate", searchHit.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("reason", guideEffective.getString("reason"));
                    effective.put("guideScore", guideEffective.getString("score"));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
                jsonArray1.add(guideEffective.getString("summary"));
                effective.getJSONArray("guide").add(jsonArray1);
            }
        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap)) {
            log.info("指南不足2篇，又进行分析");
            for (Future<Boolean> booleanFuture : futureOldList) {
                try {
                    Boolean isGetResult = booleanFuture.get();
                    if (!isGetResult) {
                        log.info("多线程中指南分析失败");
                    }
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }

            int size = guideOldEffectiveMap.size();
            do {
                List<GuideVO> guideVOS = new ArrayList<>(guideOldEffectiveMap.keySet());
                GuideVO searchHit = guideVOS.get(size - 1);
                JSONObject guideEffective = guideOldEffectiveMap.get(searchHit);
                if ((ObjectUtil.isNotNull(guideEffective.getBoolean("error")) && guideEffective.getBoolean("error"))
                        || !StrUtil.isNumeric(guideEffective.getString("score"))
                        || (StrUtil.isBlank(guideEffective.getString("summary")))
                ) {
//                    guideIndex++;
                    continue;
                }

                guideEffective.put("title", searchHit.getTitle());
                guideEffective.put("zdz", searchHit.getZdz());
                guideEffective.put("fbdate", searchHit.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("reason", guideEffective.getString("reason"));
                    effective.put("guideScore", guideEffective.getString("score"));
                    effective.put("effective", guideEffective.get("effective"));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
                jsonArray1.add(guideEffective.getString("summary"));
                effective.getJSONArray("guide").add(jsonArray1);
            } while (--guideIndex > 0 && --size > 0);

        }
    }

    private int filterGuideListSu(List<GuideVO> guideVOList, List<GuideVO> oldGuideVOList, JSONObject effective, String drugName, String disease, String id, int step, List<String> stringBuilder) {
        int guideIndex = 0;
        if (CollUtil.isEmpty(guideVOList)) {
            addProcess(id, step++, "&nbsp;暂时无法找到该药物治疗此疾病的相关指南推荐", stringBuilder);
        } else {
            for (GuideVO searchHit : guideVOList) {
                String txt = searchHit.getPdf_txt();
                if (txt.length() > 1500) {
                    txt = txt.substring(0, 1500);
                }
                // GPT3.5
                JSONObject guideEffective = new JSONObject();
                try {
                    guideEffective = effective(drugName, disease, txt);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (guideEffective.getString("score") == null) {
                        guideEffective.put("score", 0);
                    }
                    if (guideEffective.getString("reason") == null) {
                        guideEffective.put("reason", "");
                    }
                    if (guideEffective.getString("summary") == null) {
                        guideEffective.put("summary", "");
                    }
                    if (guideEffective.getString("level") == null) {
                        guideEffective.put("level", "");
                    }
                    if (guideEffective.getString("advantage") == null) {
                        guideEffective.put("advantage", "");
                    }
                    if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                        guideEffective.put("score", guideEffective.getInteger("score") + 4);
                    }
                }

                if ((ObjectUtil.isNotNull(guideEffective.getBoolean("error")) && guideEffective.getBoolean("error"))
                        || !StrUtil.isNumeric(guideEffective.getString("score"))
                        || (StrUtil.isBlank(guideEffective.getString("level")) || StrUtil.isBlank(guideEffective.getString("summary"))
                )
                ) {
                    guideIndex++;
                    continue;
                }
                addProcess(id, step++, "《" + searchHit.getTitle() + "》", stringBuilder);

                guideEffective.put("title", searchHit.getTitle());
                guideEffective.put("zdz", searchHit.getZdz());
                guideEffective.put("fbdate", searchHit.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("reason", guideEffective.getString("reason"));
                    effective.put("guideScore", guideEffective.getString("score"));
                    effective.put("score", guideEffective.getInteger("score"));
                    effective.put("advantage", StrUtil.isNotBlank(guideEffective.getString("advantage")) ? guideEffective.getString("advantage") : "暂无内容");
                    effective.put("advantageScore", StrUtil.isNotBlank(guideEffective.getString("advantage")) ? 4 : 0);
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
                jsonArray1.add(guideEffective.getString("summary"));
                effective.getJSONArray("table").add(jsonArray1);
            }

        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(oldGuideVOList)) {
            int oldGuideSize = oldGuideVOList.size();
            int count = Math.min(oldGuideSize, guideIndex);
            for (int i = 0; i < count; i++) {
                GuideVO guideVO = oldGuideVOList.get(i);
                String txt = guideVO.getPdf_txt();
                if (txt.length() > 1500) {
                    txt = txt.substring(0, 1500);
                }
                // GPT3.5
                JSONObject guideEffective = new JSONObject();
                try {
                    guideEffective = effective(drugName, disease, txt);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (guideEffective.getString("score") == null) {
                        guideEffective.put("score", 0);
                    }
                    if (guideEffective.getString("reason") == null) {
                        guideEffective.put("reason", "");
                    }
                    if (guideEffective.getString("summary") == null) {
                        guideEffective.put("summary", "");
                    }
                    if (guideEffective.getString("level") == null) {
                        guideEffective.put("level", "");
                    }
                    if (guideEffective.getString("advantage") == null) {
                        guideEffective.put("advantage", "");
                    }
                    if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                        guideEffective.put("score", guideEffective.getInteger("score") + 4);
                    }
                }

                if ((ObjectUtil.isNotNull(guideEffective.getBoolean("error")) && guideEffective.getBoolean("error"))
                        || !StrUtil.isNumeric(guideEffective.getString("score"))
                        || (StrUtil.isBlank(guideEffective.getString("level")) || StrUtil.isBlank(guideEffective.getString("summary")))
                ) {
                    continue;
                }

                addProcess(id, step++, "《" + guideVO.getTitle() + "》", stringBuilder);

                guideEffective.put("title", guideVO.getTitle());
                guideEffective.put("zdz", guideVO.getZdz());
                guideEffective.put("fbdate", guideVO.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("reason", guideEffective.getString("reason"));
                    effective.put("guideScore", guideEffective.getString("score"));
                    effective.put("score", guideEffective.getInteger("score"));
                    effective.put("advantage", StrUtil.isNotBlank(guideEffective.getString("advantage")) ? guideEffective.getString("advantage") : "暂无内容");
                    effective.put("advantageScore", StrUtil.isNotBlank(guideEffective.getString("advantage")) ? 4 : 0);
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(guideVO.getTitle());
                jsonArray1.add(guideVO.getZdz());
                jsonArray1.add(guideVO.getFbdate());
                jsonArray1.add(StrUtil.isBlank(guideEffective.getString("grade")) ? "" : guideEffective.getString("grade"));
                jsonArray1.add(guideEffective.getString("summary"));
                effective.getJSONArray("table").add(jsonArray1);
            }
        }
        return step;
    }

    private void filterGuideListSuApp(List<GuideVO> guideVOList, JSONObject effective, String drugName, String disease) {
        if (CollUtil.isNotEmpty(guideVOList)) {
            for (GuideVO guideVO : guideVOList) {
                try {
                    String txt = guideVO.getPdf_txt();
                    if (txt.length() > 1000) {
                        txt = txt.substring(0, 1000);
                    }
                    JSONObject jsonObject = effective(drugName, disease, txt);
                    jsonObject.put("title", guideVO.getTitle());
                    jsonObject.put("zdz", guideVO.getZdz());
                    if (effective.getInteger("vscore") == null || effective.getInteger("vscore") < jsonObject.getInteger("score")) {
                        effective.put("score", "有效性得分为：" + jsonObject.getInteger("score") + "分");
                        effective.put("vscore", jsonObject.getInteger("score"));
                        effective.put("advantage", StrUtil.isNotBlank(jsonObject.getString("advantage")) ? jsonObject.getString("advantage") : "暂无内容");
                        effective.put("reason", jsonObject.getString("reason"));
                        effective.put("advantageScore", StrUtil.isNotBlank(jsonObject.getString("advantage")) ? 4 : 0);
                        effective.put("guideScore", jsonObject.getInteger("score"));
                    }
                    JSONArray jsonArray1 = new JSONArray();
                    jsonArray1.add(guideVO.getTitle());
                    jsonArray1.add(guideVO.getZdz());
                    jsonArray1.add(guideVO.getFbdate());
                    jsonArray1.add(jsonObject.getString("level"));
                    jsonArray1.add(jsonObject.getString("summary"));
                    effective.getJSONArray("table").add(jsonArray1);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
        }


    }

    private void montageForPaper(StringBuilder query, List<String> inner, String type) {
        query.append("(");
        for (int i = 0; i < inner.size() - 1; i++) {
            // 去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                query.append(s).append("[").append(type).append("]").append(" OR ");
            } else {
                query.append(s).append(" OR ");
            }
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            query.append(s).append("[").append(type).append("]");
        } else {
            query.append(s);
        }
        query.append(")");
    }

    private String getRegex(List<String> strings) {

        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("(");
        for (String string : strings) {
            string = string.replaceAll("\\+", "");
            string = string.replaceAll("\\(", "");
            string = string.replaceAll("\\)", "");
            string = string.replaceAll("\\?", "");
            stringBuilder.append(string).append("|");
        }
        stringBuilder.delete(stringBuilder.length() - 1, stringBuilder.length());
        stringBuilder.append(")");
        return stringBuilder.toString();
    }

    @Override
    public List<Literature> queryLiterature(String drugName, List<String> drugs, String disease, List<String> diseases) {
        /*BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder drugBoolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder diseaseBoolQueryBuilder = QueryBuilders.boolQuery();*/
        long startTime = System.currentTimeMillis();
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        diseases = diseases.stream().distinct().collect(Collectors.toList());

        /*for(String drug : drugs) {
            MultiMatchQueryBuilder drugMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "title","allKeyword","tldr","titleQuestion");
            drugMultiMatchQueryBuilder.field("title", 100f);
            drugMultiMatchQueryBuilder.field("allKeyword", 20f);
            drugMultiMatchQueryBuilder.field("tldr", 20f);
            drugMultiMatchQueryBuilder.field("titleQuestion", 20f);
            drugMultiMatchQueryBuilder.operator(Operator.AND);
            drugMultiMatchQueryBuilder.slop(0);
            drugMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            drugBoolQueryBuilder.should().add(drugMultiMatchQueryBuilder);
        }

        for(String str : diseases) {
            MultiMatchQueryBuilder diseaseMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(str, "title","allKeyword","tldr","titleQuestion");
            diseaseMultiMatchQueryBuilder.field("title", 100f);
            diseaseMultiMatchQueryBuilder.field("allKeyword", 20f);
            diseaseMultiMatchQueryBuilder.field("tldr", 20f);
            diseaseMultiMatchQueryBuilder.field("titleQuestion", 20f);
            diseaseMultiMatchQueryBuilder.operator(Operator.AND);
            diseaseMultiMatchQueryBuilder.slop(0);
            diseaseMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            diseaseBoolQueryBuilder.should().add(diseaseMultiMatchQueryBuilder);
        }*/
        // 使用检索中心检索式格式进行检索
        StringBuilder query = new StringBuilder();
        montageForPaper(query, drugs, "精筛");
        if (CollUtil.isNotEmpty(diseases)) {
            query.append(" AND ");
            montageForPaper(query, diseases, "精筛");
        }
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        LinkedMultiValueMap<String, String> mapQuery = new LinkedMultiValueMap<>();
//        mapQuery.put("query", Collections.singletonList(query.toString()));
//        mapQuery.put("type", Collections.singletonList("1"));
//        String retrievalStr = evidenceFeign.retrieval(mapQuery);
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", query.toString());
        jsonObject.put("type", "1");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
        TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("type", 3);
        boolQueryBuilder.must().add(termQueryBuilder);
        boolQueryBuilder.must().add(QueryBuilders.wrapperQuery(retrievalStr));
        JSONObject dataJason = new JSONObject();
        List<Integer> integers = Arrays.asList(1, 2);
        dataJason.put("screenId", UUID.randomUUID());
        dataJason.put("query", boolQueryBuilder.toString());
        dataJason.put("language", integers);
        dataJason.put("searchQuery", drugName + "治疗" + disease);
        dataJason.put("type", 2);
        dataJason.put("status", 1);
        long l = System.currentTimeMillis();
        List<String> ids = fineScreenFeign.mixSearch(dataJason);
        log.info("检索中心检索文献耗时{}ms", System.currentTimeMillis() - l);
        IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
        idsQueryBuilder.ids().addAll(ids);
        BoolQueryBuilder boolQueryBuilder1 = QueryBuilders.boolQuery();
        boolQueryBuilder1.must().add(termQueryBuilder);
        boolQueryBuilder1.must().add(idsQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder1);
        // 根据返回id查询
        SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
        log.info("在es中查出文献{}篇", literatureSearchHits.getTotalHits());

        List<Literature> literatureList = new ArrayList<>();
        List<SearchHit<Literature>> collect = literatureSearchHits.getSearchHits().stream().filter(literature -> {
            double jcr = literature.getContent().getJcr();
            if (StrUtil.equals(literature.getContent().getLanguage(), CommonConstants.LANGUAGE_ZH)) {
                if (ObjectUtil.isNotNull(jcr) && jcr > 0) {
                    return true;
                }
            }

            if (StrUtil.equals(literature.getContent().getLanguage(), CommonConstants.LANGUAGE_EN)) {
                return ObjectUtil.isNotNull(jcr) && jcr > 2;
            }
            return false;
        }).collect(Collectors.toList());

        if (CollUtil.isEmpty(collect)) {
            collect = literatureSearchHits.getSearchHits();
        }

        for (SearchHit<Literature> literatureSearchHit : collect) {
            literatureList.add(literatureSearchHit.getContent());
            log.info("需要分析的文献有{}", literatureSearchHit.getContent().getTitle());
        }
        log.info("疾病{}, 药{}, 经过jcr筛选，查询出来的文献数量是{}", drugName, disease, literatureList.size());
        long endTime = System.currentTimeMillis();
        log.info("********************************检索文献耗时{}ms***********************", endTime - startTime);
        return literatureList;

    }


    private static final int BATCH_SIZE = 10;

    public GuideAndScore processGuides(List<GuideVO> guideVOS, String drugName, String disease) {
        if (guideVOS == null || guideVOS.isEmpty()) {
            return new GuideAndScore();
        }


        // 整体处理
        BatchResult resultTo = processBatchTo(guideVOS, drugName, disease);

        if (resultTo != null) {

            GuideAndScore guideAndScore = new GuideAndScore();
            guideAndScore.setScore(resultTo.getScore());
            ArrayList<GuideVO> guideVOS1 = new ArrayList<>();
                for (GuideVO guideVO : guideVOS) {
                    if (resultTo.getIds().contains(guideVO.getId())) {
                        guideVOS1.add(guideVO);
                    }
                }

            guideAndScore.setGuideVOS(guideVOS1);
            return guideAndScore;

        }


        // 存储每批处理结果
        List<BatchResult> batchResults = new ArrayList<>();

        // 分批处理指南数据
        int batchCount = (int) Math.ceil((double) guideVOS.size() / BATCH_SIZE);
        for (int i = 0; i < batchCount; i++) {
            int fromIndex = i * BATCH_SIZE;
            int toIndex = Math.min(fromIndex + BATCH_SIZE, guideVOS.size());
            List<GuideVO> batch = guideVOS.subList(fromIndex, toIndex);

            BatchResult result = processBatch(batch, drugName, disease);
            if (result != null) {
                batchResults.add(result);
            }

        }

        // 合并所有批次的结果
        return mergeBatchResults(batchResults, guideVOS);
    }

    public GuideAndScore getMustGuideByDrugAndDisease(List<String> drugs, String drugName, List<String> diseases, String disease) {
        // 查询指南数据
        List<GuideVO> guideVOS = queryGuideByDrugAndDisease1(drugs, drugName, diseases, disease);

        // 使用现有的分批处理逻辑
        return processGuides(guideVOS, drugName, disease);
    }

    private BatchResult processBatch(List<GuideVO> batch, String drugName, String disease) {
        // 构建指南信息字符串
        StringBuilder guideChooseBuilder = new StringBuilder();
        for (GuideVO guideVO : batch) {

            if (StringUtils.isEmpty(guideVO.getId())) {
                continue;
            }
            if (guideVO.getPdf_txt() != null && guideVO.getPdf_txt().length() > 1000) {
                guideVO.setPdf_txt(guideVO.getPdf_txt().substring(0, 1000));
            }


            guideChooseBuilder.append("**************$$$指南id:")
                    .append(guideVO.getId())
                    .append("  $$$标题:")
                    .append(guideVO.getTitle())
                    .append("  $$$机构:")
                    .append(guideVO.getZdz())
                    .append("  $$$来源:")
                    .append(guideVO.getSource())
                    .append("  $$$内容:")
                    .append(guideVO.getPdf_txt())
                    .append("*********\n");
        }
        String guideChoose = guideChooseBuilder.toString();
        if (StringUtils.isEmpty(guideChoose)) {
            return null;
        }
        // 构建提示信息
        String prompt = "我正在研究以下课题：" + drugName + "治疗" + disease + ".\n\n" +
                "我正在研究《" + drugName + "治疗" + disease + "》的课题，请根据以下评分规则从提供的指南中筛选出得分最高的指南（最多5篇，ID间用中文逗号分隔）。若无关则返回\"无\"。\n" +
                "评分规则（优先级从高到低）\n" +
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
                guideChoose +
                "请帮挑选并返回，返回内容包括：1.选中的指南id（多个id用','隔开返回）；2.这批指南符合的分数（最高12分，最低4分，返回一个阿拉伯数字），整体以json返回" +
                "******注意：要准确，要返回的这批指南都符合这个分数******";

        // 设置响应格式
        HashMap<String, String> responseFields = new HashMap<>();
        responseFields.put("id", "返回的指南id，多个id用','隔开返回");
        responseFields.put("score", "这批指南符合的分数（最高12分，最低4分，返回一个阿拉伯数字）");
        JSONObject responseFormat = getResponseFormat(responseFields);

        // 调用GPT处理
        JSONObject jsonResponse = executeGptPlus(prompt, "西药指南", responseFormat, "gpt-4.1-nano-2025-04-14","12,11,10,9,8,7,6,5,4");

        // 解析响应
        String ids = jsonResponse.getString("id");
        String score = jsonResponse.getString("score");

        return new BatchResult(ids, score);
    }


    private BatchResult processBatchTo(List<GuideVO> batch, String drugName, String disease) {
        // 构建指南信息字符串
        StringBuilder guideChooseBuilder = new StringBuilder();
        for (GuideVO guideVO : batch) {

            if (StringUtils.isEmpty(guideVO.getId())) {
                continue;
            }


            guideChooseBuilder.append("**************指南id:")
                    .append(guideVO.getId())
                    .append("  标题:")
                    .append(guideVO.getTitle())
                    .append("  机构:")
                    .append(guideVO.getZdz())
                    .append("  来源:")
                    .append(guideVO.getSource())
                    .append("*********\n");
        }
        String guideChoose = guideChooseBuilder.toString();
        if (StringUtils.isEmpty(guideChoose)) {
            return null;
        }
        // 构建提示信息
        String prompt = "prompt1：请根据提供的指南信息，筛选符合以下任一条件的指南ID（最多返回5个，ID间用中文逗号分隔），并以JSON格式反馈。若均不符合，返回\"无\"。\n" +
                "筛选规则：\n" +
                "1.诊疗规范类：标题或类型含\"诊疗规范\"\"指导原则\"等关键词；\n" +
                "2.临床路径类：标题或类型明确提及\"临床路径\"；\n" +
                "3.国家级行政机构发布：发布机构为国家卫健委、国家卫生部等国家级卫生行政部门，且类型为\"共识\"或\"管理办法\"。\n" +
                "指南信息如下：" +
                guideChoose +
                "请帮挑选并返回，返回内容包括：1.选中的指南id（多个id用','隔开返回）整体以json返回" +
                "******注意：要准确，要返回的这批指南符合上述任意一个条件******";

        // 设置响应格式
        HashMap<String, String> responseFields = new HashMap<>();
        responseFields.put("id", "返回的指南id，多个id用','隔开返回");
        JSONObject responseFormat = getResponseFormat(responseFields);

        // 调用GPT处理
        JSONObject jsonResponse = executeGptPlus(prompt, "西药指南", responseFormat, "gpt-4.1-nano-2025-04-14","");

        // 解析响应
        String ids = jsonResponse.getString("id");
        if (StringUtils.isEmpty(ids)) {
            return null;
        }
        return new BatchResult(ids, "12");
    }

    private GuideAndScore mergeBatchResults(List<BatchResult> batchResults, List<GuideVO> allGuides) {
        // 按分数降序排序
        batchResults.sort(Comparator.comparingInt(r -> -Integer.parseInt(r.getScore())));

        // 收集所有选中的指南ID和最高分数
        Set<String> selectedIds = new LinkedHashSet<>();
        String highestScore = null;

        if (CollUtil.isEmpty(batchResults)) {
            GuideAndScore guideAndScore = new GuideAndScore();
            guideAndScore.setGuideVOS(allGuides);
            guideAndScore.setScore("0");
        }

        for (BatchResult result : batchResults) {
            if (highestScore == null) {
                highestScore = result.getScore();
            }

            // 只收集与最高分数相同的批次
            if (result.getScore().equals(highestScore)) {
                String[] ids = result.getIds().split(",");
                for (String id : ids) {
                    if (!id.isEmpty() && selectedIds.size() < 5) {
                        selectedIds.add(id);
                    }
                }
            } else {
                // 批次分数低于当前最高分数，停止处理
                break;
            }
        }

        // 构建最终结果
        GuideAndScore finalResult = new GuideAndScore();
        finalResult.setScore(highestScore);

        if (!selectedIds.isEmpty()) {
            List<GuideVO> selectedGuides = allGuides.stream()
                    .filter(guide -> selectedIds.contains(guide.getId()))
                    .collect(Collectors.toList());
            finalResult.setGuideVOS(selectedGuides);
        }

        return finalResult;
    }

    private static class BatchResult {
        private final String ids;
        private final String score;

        public BatchResult(String ids, String score) {
            this.ids = ids;
            this.score = score;
        }

        public String getIds() {
            return ids;
        }

        public String getScore() {
            return score;
        }
    }


    /**
     * 根据drugName药品名称和disease疾病去
     *
     * @param drugs    药品同义词
     * @param drugName 药品名称
     * @param diseases 疾病同义词
     * @param disease  疾病名称
     * @return 返回查询到的指南
     */
    public List<GuideVO> queryGuideByDrugAndDisease1(List<String> drugs, String drugName, List<String> diseases, String disease) {
        long startTime = System.currentTimeMillis();

        StringBuilder query = new StringBuilder();
        ArrayList<String> strings = new ArrayList<>();

        montageForPaper(query, drugs, "");
        if (CollUtil.isNotEmpty(diseases)) {
            query.append(" AND ");
            montageForPaper(query, diseases, "");
        }
        // 检索中台组装条件

        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", query.toString());
        jsonObject.put("type", "2");
        String retrievalStr = formulaFeign.retrieval(jsonObject);

        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
        // 指南筛选
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
        guideQuery.must().add(wrapperQueryBuilder);


        // 构建 function_score 查询
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[3];
        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);

        Script script1 = new Script(buildScriptByDrugAndDisease(drugs, diseases));
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder1 = new ScriptScoreFunctionBuilder(script1);
        filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder1);

        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        NativeSearchQuery nativeSearchQuery;
        nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        List<Map<String, String>> guideInfo = new ArrayList<>();
        ArrayList<SearchHit<GuideVO>> search = new ArrayList<>();
        long mayIncludeCount = elasticsearchRestTemplate.count(nativeSearchQuery, GuideVO.class);
        if (mayIncludeCount > 0) {
            int cycle = (int) (mayIncludeCount % 10 == 0 ? mayIncludeCount / 10 : mayIncludeCount / 10 + 1);
            if (cycle > 5) {
                cycle = 5;
            }
            for (int i = 0; i < cycle; i++) {
                NativeSearchQuery innerNativeSearchQuery;
                FunctionScoreQueryBuilder innerFunctionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
                innerFunctionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
                innerFunctionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
                innerNativeSearchQuery = new NativeSearchQuery(innerFunctionScoreQueryBuilder);
                innerNativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
                innerNativeSearchQuery.setPageable(PageRequest.of(i, 10));
                // 开始查询
                SearchHits<GuideVO> searchHits = elasticsearchRestTemplate.search(innerNativeSearchQuery, GuideVO.class);
                search.addAll(searchHits.getSearchHits());
            }
        }

        ArrayList<GuideVO> guideVOList = new ArrayList<>();
        if (search.size() == 0) {
            return new ArrayList<>();

        } else {
            for (SearchHit<GuideVO> guideVOSearchHit : search) {
                log.info("title{}", guideVOSearchHit.getContent().getTitle());
            }
        }


        for (SearchHit<GuideVO> guideVOSearchHit : search) {
            GuideVO content = guideVOSearchHit.getContent();
            List<String> strings1 = searchBlockOnex(content, content.getLanguage(), drugs, diseases);
            if (CollUtil.isNotEmpty(strings1)) {
                String block = searchBlock1(strings1, content.getLanguage(), drugs, diseases);
                content.setPdf_txt(block);
            } else {
                continue;
            }
            guideVOList.add(content);
        }

        if (guideVOList.size() == 0) {
            return new ArrayList<>();
        }
        return guideVOList;
    }

    /**
     * 根据drugName药品名称和disease疾病去
     *
     * @param drugs    药品同义词
     * @param drugName 药品名称
     * @param diseases 疾病同义词
     * @param disease  疾病名称
     * @return 返回查询到的指南
     */
    public List<GuideVO> queryGuideByDrugAndDiseaseTr(List<String> drugs, String drugName, List<String> diseases, String disease) {
        long startTime = System.currentTimeMillis();

        StringBuilder query = new StringBuilder();
        ArrayList<String> strings = new ArrayList<>();

        montageForPaper(query, drugs, "");
        if (CollUtil.isNotEmpty(diseases)) {
            query.append(" AND ");
            montageForPaper(query, diseases, "");
        }
        // 检索中台组装条件

        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", query.toString());
        jsonObject.put("type", "2");
        String retrievalStr = formulaFeign.retrieval(jsonObject);

        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
        // 指南筛选
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
        guideQuery.must().add(wrapperQueryBuilder);


        // 构建 function_score 查询
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[3];
        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);

        Script script1 = new Script(buildScriptByDrugAndDisease(drugs, diseases));
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder1 = new ScriptScoreFunctionBuilder(script1);
        filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder1);

        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        NativeSearchQuery nativeSearchQuery;
        nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        List<Map<String, String>> guideInfo = new ArrayList<>();
        ArrayList<SearchHit<GuideVO>> search = new ArrayList<>();
        long mayIncludeCount = elasticsearchRestTemplate.count(nativeSearchQuery, GuideVO.class);
        if (mayIncludeCount > 0) {
            int cycle = (int) (mayIncludeCount % 10 == 0 ? mayIncludeCount / 10 : mayIncludeCount / 10 + 1);
            if (cycle > 10) {
                cycle = 10;
            }
            for (int i = 0; i < cycle; i++) {
                NativeSearchQuery innerNativeSearchQuery;
                FunctionScoreQueryBuilder innerFunctionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
                innerFunctionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
                innerFunctionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
                innerNativeSearchQuery = new NativeSearchQuery(innerFunctionScoreQueryBuilder);
                innerNativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
                innerNativeSearchQuery.setPageable(PageRequest.of(i, 10));
                // 开始查询
                SearchHits<GuideVO> searchHits = elasticsearchRestTemplate.search(innerNativeSearchQuery, GuideVO.class);
                search.addAll(searchHits.getSearchHits());
            }
        }

        ArrayList<GuideVO> guideVOList = new ArrayList<>();
        if (search.size() == 0) {
            return searchGuideTop5(drugName, disease);

        } else {
            for (SearchHit<GuideVO> guideVOSearchHit : search) {
                log.info("title{}", guideVOSearchHit.getContent().getTitle());
            }
        }


        for (SearchHit<GuideVO> guideVOSearchHit : search) {
            GuideVO content = guideVOSearchHit.getContent();
            List<String> strings1 = searchBlockOne(content, drugs, diseases);
            if (CollUtil.isNotEmpty(strings1)) {
                String block = searchBlockTr(strings1, content.getLanguage(), drugs, diseases);
                content.setPdf_txt(block);
            }
            guideVOList.add(content);
        }

        if (guideVOList.size() == 0) {
            return searchGuideTop5(drugName, disease);
        }
        return guideVOList;
    }

    /**
     * 根据drugName药品名称和disease疾病去
     *
     * @param drugs    药品同义词
     * @param drugName 药品名称
     * @param diseases 疾病同义词
     * @param disease  疾病名称
     * @return 返回查询到的指南
     */
    @Override
    public List<GuideVO> queryGuideByDrugAndDisease(List<String> drugs, String drugName, List<String> diseases, String disease) {
        long startTime = System.currentTimeMillis();
        /*BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder drugBoolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder diseaseBoolQueryBuilder = QueryBuilders.boolQuery();
        for(String drug : drugs) {
            MultiMatchQueryBuilder drugMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "title","keywords","nrjs","pdf_txt");
            drugMultiMatchQueryBuilder.field("title", 100f);
            drugMultiMatchQueryBuilder.field("keywords", 50f);
            drugMultiMatchQueryBuilder.field("nrjs", 20f);
            drugMultiMatchQueryBuilder.field("pdf_txt", 1f);
            drugMultiMatchQueryBuilder.operator(Operator.AND);
            drugMultiMatchQueryBuilder.slop(0);
            drugMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            drugBoolQueryBuilder.should().add(drugMultiMatchQueryBuilder);
        }

        for(String dis : diseases) {
            MultiMatchQueryBuilder diseaseMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(dis, "title","keywords","nrjs","pdf_txt");
            diseaseMultiMatchQueryBuilder.field("title", 100f);
            diseaseMultiMatchQueryBuilder.field("keywords", 50f);
            diseaseMultiMatchQueryBuilder.field("nrjs", 20f);
            diseaseMultiMatchQueryBuilder.field("pdf_txt", 1f);
            diseaseMultiMatchQueryBuilder.operator(Operator.AND);
            diseaseMultiMatchQueryBuilder.slop(0);
            diseaseMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            diseaseBoolQueryBuilder.should().add(diseaseMultiMatchQueryBuilder);
        }
        boolQueryBuilder.must().add(drugBoolQueryBuilder);
        boolQueryBuilder.must().add(diseaseBoolQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);*/
        // 使用检索中心检索式格式进行检索
        StringBuilder query = new StringBuilder();
        ArrayList<String> strings = new ArrayList<>();

        montageForPaper(query, drugs, "");
        if (CollUtil.isNotEmpty(diseases)) {
            query.append(" AND ");
            montageForPaper(query, diseases, "");
        }
        // 检索中台组装条件
//        JSONObject jsonObject = new JSONObject();
//        jsonObject.put("query", query.toString());
//        jsonObject.put("type", 2);
//        String retrievalStr = formulaFeign.retrieval(jsonObject);
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("query", query.toString());
        jsonObject.put("type", "2");
        String retrievalStr = formulaFeign.retrieval(jsonObject);
//        JSONObject dataJason = new JSONObject();
//        // 获取当前时间
//        LocalDateTime now = LocalDateTime.now();
//        // 精确到小时的时间
////        LocalDateTime hourPrecision = now.truncatedTo(java.time.temporal.ChronoUnit.HOURS);
//        String screenId = SecurityUtil.getMd5(retrievalStr + System.currentTimeMillis());
//        dataJason.put("screenId", screenId);
//        dataJason.put("query", retrievalStr);
//        dataJason.put("searchQuery", drugName + "治疗" + disease);
//        dataJason.put("type", 2);
//        dataJason.put("status", 2);
//        ArrayList<List<String>> wordList = new ArrayList<>();
//        wordList.add(drugs);
//        wordList.add(diseases);
//        dataJason.put("wordList", wordList);
//        log.info("检索式{}", dataJason.toString());
//        List<String> ids = fineScreenFeign.mixSearch(dataJason);
//        JSONObject blocks1 = fineScreenFeign.getBlocks(screenId);
//        log.info("block:{}", blocks1.toString());
//        log.info("查询到指南id{}", ids.toString());
//        try {
//            if (CollUtil.isNotEmpty(ids)) {
//                //如果查询到了,更新缓存
//                redisTemplate.opsForValue().set("evaluationId:" + drugName + "治疗" + disease, ids, 3, TimeUnit.DAYS);
//                redisTemplate.opsForValue().set("evaluationBlock:" + drugName + "治疗" + disease, blocks1, 3, TimeUnit.DAYS);
//            } else {
//                //如果无返回，使用上次查询到的指南
//                ids = (List<String>) redisTemplate.opsForValue().get("evaluationId:" + drugName + "治疗" + disease);
//                blocks1 = (JSONObject) redisTemplate.opsForValue().get("evaluationBlock:" + drugName + "治疗" + disease);
//                log.info("redis获取的id{}", ids.toString());
//            }
//            //可能没记录也没返回
//        } catch (Exception e) {
//            log.error("redis异常", e);
//        }
////        long begin = System.currentTimeMillis();
////        // 存储经过筛选并截取完的指南
//        List<GuideVO> guideVOList = new ArrayList<>();
//        if (CollUtil.isEmpty(ids)) {
//            return guideVOList;
//        }
//        List<SearchHit<GuideVO>> search = new ArrayList<>();
//        long size;
//        int i = 0;
//        do {
//            IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
//            idsQueryBuilder.ids().addAll(ids.subList(i * 10, i * 10 + 10));
//            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
//            nativeSearchQuery.setPageable(PageRequest.of(i, 10));
//            SearchHits<GuideVO> searchx = this.elasticsearchRestTemplate.search(nativeSearchQuery, GuideVO.class);
//            i++;
//             size = searchx.getSearchHits().size();
//            List<SearchHit<GuideVO>> searchHits = searchx.getSearchHits();
//            search.addAll(searchHits);
//        }while (size==10);
        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
        // 指南筛选
        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
        guideQuery.must().add(wrapperQueryBuilder);


        // 构建 function_score 查询
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[3];
        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);

//        if (CollUtil.isNotEmpty(drugSynonym) && CollUtil.isNotEmpty(diseaseSynonym)) {
//            StringBuilder scriptStr1 = new StringBuilder("double score=_score;double disScore=");
//            for (String dis : diseaseSynonym) {
//                scriptStr1.append("doc['name'].getValue().contains('").append(dis).append("')||");
//            }
//            String scriptStr1String = scriptStr1.toString();
//            scriptStr1String = scriptStr1String.substring(0, scriptStr1String.lastIndexOf("||"));
//            scriptStr1String += "?3*1000:0;";
//
//            StringBuilder scriptStr2 = new StringBuilder("double drugScore=");
//            for (String drug : drugSynonym) {
//                scriptStr2.append("doc['name'].getValue().contains('").append(drug).append("')||");
//            }
//            String scriptStr2String = scriptStr2.toString();
//            scriptStr2String = scriptStr2String.substring(0, scriptStr2String.lastIndexOf("||"));
//            scriptStr2String += "?1*1000:0;";
//            String scriptStr3String = scriptStr1String + scriptStr2String + "return disScore+drugScore+score";
//            Script script1 = new Script(scriptStr3String);
//            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder1 = new ScriptScoreFunctionBuilder(script1);
//            filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder1);
//        }

        Script script1 = new Script(buildScriptByDrugAndDisease(drugs, diseases));
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder1 = new ScriptScoreFunctionBuilder(script1);
        filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder1);

        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        NativeSearchQuery nativeSearchQuery;
        nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        List<Map<String, String>> guideInfo = new ArrayList<>();
        ArrayList<SearchHit<GuideVO>> search = new ArrayList<>();
        long mayIncludeCount = elasticsearchRestTemplate.count(nativeSearchQuery, GuideVO.class);
        if (mayIncludeCount > 0) {
            int cycle = (int) (mayIncludeCount % 10 == 0 ? mayIncludeCount / 10 : mayIncludeCount / 10 + 1);
            if (cycle > 10) {
                cycle = 10;
            }
            for (int i = 0; i < cycle; i++) {
                NativeSearchQuery innerNativeSearchQuery;
                FunctionScoreQueryBuilder innerFunctionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
                innerFunctionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
                innerFunctionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
                innerNativeSearchQuery = new NativeSearchQuery(innerFunctionScoreQueryBuilder);
                innerNativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
                innerNativeSearchQuery.setPageable(PageRequest.of(i, 10));
                // 开始查询
                SearchHits<GuideVO> searchHits = elasticsearchRestTemplate.search(innerNativeSearchQuery, GuideVO.class);
                search.addAll(searchHits.getSearchHits());
            }
        }

        ArrayList<GuideVO> guideVOList = new ArrayList<>();
        List<GuideVO> oneLevel = new ArrayList<>();
        List<GuideVO> twoLevel = new ArrayList<>();
        List<GuideVO> threeLevel = new ArrayList<>();
        List<GuideVO> fourLevel = new ArrayList<>();
        int size = 0;
        // 实际量
        int size1 = search.size();
        Semaphore semaphore = new Semaphore(0);

        for (SearchHit<GuideVO> guideVOSearchHit : search) {
            if (size >= 20) {
                break;
            }
            GuideVO content = guideVOSearchHit.getContent();
            List<String> strings1 = searchBlockOne(content, drugs, diseases);
            if (CollUtil.isNotEmpty(strings1) && CollUtil.isNotEmpty(diseases)) {
                size += 1;
                    String block = searchBlock(strings1, content.getLanguage(), drugs, diseases);
                    content.setBlock(block);
                    if (checkFullWordContain(content.getTitle(), drugs) && checkFullWordContain(content.getTitle(), diseases)) {
                        oneLevel.add(content);
                    } else if (checkFullWordContain(content.getTitle(), diseases)) {
                        twoLevel.add(content);
                    } else if (checkFullWordContain(content.getTitle(), drugs)) {
                        content.setPdf_txt(block);
                        threeLevel.add(content);
                    } else {
                        fourLevel.add(content);
                    }
                    semaphore.release();

            } else if (CollUtil.isNotEmpty(strings1)) {

                String block = searchBlock(strings1, content.getLanguage(), drugs, diseases);

                content.setBlock(block);

                if (checkFullWordContain(content.getTitle(), drugs)) {
                    content.setBlock(block);
                    threeLevel.add(content);
                } else {
                    fourLevel.add(content);
                }
                semaphore.release();
            }
        }
        try {
            semaphore.acquireUninterruptibly(size);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        guideVOList.addAll(oneLevel);
        guideVOList.addAll(twoLevel);
        guideVOList.addAll(threeLevel);
        guideVOList.addAll(fourLevel);
        long endTime = System.currentTimeMillis();
        log.info("药{},疾病{}, 需要经过gpt分析的指南数量是{}", drugName, disease, guideVOList.size());
        log.info("***************************指南单个耗时{}*******************************", (endTime - startTime));

        return guideVOList;
    }


    public List<String> searchBlockOnex(GuideVO guideIndex, String language, List<String> drugSynonym, List<String> diseaseSynonym) {

        List<String> blocks = new ArrayList<>();

        List<String> blockx = guideIndex.getBlocks();
        for (String block : blockx) {
            if (checkFullWordContain(block, drugSynonym) &&
                    checkFullWordContain(block, diseaseSynonym)) {
                blocks.add(block);
            }


            if (CollUtil.isNotEmpty(blocks)) {
                return blocks;
            }
        }
        return null;
    }

    public List<String> searchBlockOne(GuideVO guideVO,  List<String> drugSynonym, List<String> diseaseSynonym) {


        if (CollUtil.isNotEmpty(guideVO.getBlocks())) {
            List<String> blocks = new ArrayList<>();
            for (String block : guideVO.getBlocks()) {
                if (checkFullWordContain(block, drugSynonym) &&
                        checkFullWordContain(block, diseaseSynonym)) {
                    blocks.add(block);
                }
            }

            if (CollUtil.isNotEmpty(blocks)) {
                return blocks;
            }
        }
        return null;
    }


    public String searchBlockTr(List<String> blocks, String language, List<String> drugSynonym, List<String> diseaseSynonym) {
        String block = "";
        int i = 1;
        for (String s : blocks) {
            block = "节选" + i + ":" + s + "....\n";
            i++;
        }
        if (block.length() > 1000) {
            return block.substring(0, 1000);
        }

        return block;
    }

    public String searchBlock1(List<String> blocks, String language, List<String> drugSynonym, List<String> diseaseSynonym) {
        String block = "";
        int i = 1;
        for (String s : blocks) {
            block = block + s + "\n";
            i++;
        }
        block = block.substring(0, block.length() - 1);
        if (block.length() > 3000) {
            return block.substring(0, 3000);
        }

        return block;
    }


    public String searchBlock(List<String> blocks, String language, List<String> drugSynonym, List<String> diseaseSynonym) {
        if (blocks.size() == 1) {
            return blocks.get(0);
        }
        String block = "";
        for (String s : blocks) {
            block = block + s + "\n";
        }

        return block;
    }

    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

    private String buildScriptByDrugAndDisease(List<String> drugSynonym, List<String> diseaseSynonym) {
        StringBuilder script = new StringBuilder();
        script.append("double score = _score;");

        // 处理疾病同义词
        if (CollUtil.isEmpty(diseaseSynonym)) {
            script.append("double disScore = 0;");
        } else {
            String disCondition = buildCondition(diseaseSynonym);
            script.append("double disScore = ").append(disCondition).append(" ? 1 : 0;");
        }

        // 处理药物同义词
        if (CollUtil.isEmpty(drugSynonym)) {
            script.append("double drugScore = 0;");
        } else {
            String drugCondition = buildCondition(drugSynonym);
            script.append("double drugScore = ").append(drugCondition).append(" ? 1 : 0;");
        }

        script.append("return 1000 * disScore + 300 * Math.sqrt(drugScore) + score;");
        return script.toString();
    }

    private String buildCondition(List<String> synonyms) {
        StringBuilder condition = new StringBuilder();
        for (String synonym : synonyms) {
            synonym = synonym.replaceAll("\'", "\\\\'");
            condition.append("doc['name'].getValue().toLowerCase().contains('").append(synonym).append("') || ");
        }
        if (condition.length() > 0) {
            condition.delete(condition.length() - 4, condition.length()); // 移除最后一个 " || "
        }
        return condition.toString();
    }

    public static boolean checkFullWordContain(String text, List<String> synonym) {
        try {


            boolean match = false;
            text = text.replaceAll("\n", "");
            boolean chinese = text.matches(".*[\u4e00-\u9fff].*");
            boolean english = text.matches(".*[a-zA-Z].*");
            if (english) {
                for (String word : synonym) {
                    // 对特殊字符进行转义
                    word = word.replaceAll("([+\\-\\[\\]{}()*^$.|?])", "\\\\$1");
                    // 使用正则表达式来匹配完整的单词
                    String pattern = "\\b" + word + "\\b";
                    Pattern compiledPattern = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
                    Matcher matcher = compiledPattern.matcher(text);
                    if (matcher.find()) {
                        match = true;
                        break;
                    }
//                if (text.matches(".*" + pattern + ".*")) {
//                    match = true;
//                    break;
//                }
                }
                if (chinese) {
                    match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
                }
            } else {
                match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
            }
            return match;
        } catch (NullPointerException e) {
            return true;
        }
    }

    public List<GuideVO> searchGuideTop5(String drug, String disease) {
//         OkHttpClient client = new OkHttpClient()
//                 .newBuilder()
//                 .connectTimeout(120, TimeUnit.SECONDS)
//                 .readTimeout(240, TimeUnit.SECONDS)
//                 .writeTimeout(120, TimeUnit.SECONDS)
//                 .build();
//
//         Map<Object, Object> req = new HashMap<>();
// //        req.put("model", "deepseek-r1");
//         req.put("model", "deepseek-v3");
//         req.put("max_tokens", 4096);
//         JSONArray message = new JSONArray();
//         JSONObject m2 = new JSONObject();
//         m2.put("content", "请帮忙查找几篇关于药物：" + drug + ((StringUtils.isNotEmpty(disease)) ? "，在病症" + disease + "方面" : "") + "的几篇相关度较高的指南文章（如果多余 5 篇，按照相关度选取前 5 篇），" +
//                 "要求给出具体的指南标题title（需要显示指南的原标题，即语言跟随原标题显示，不要强制转成中文标题）、" +
//                 "总结内容content(可以显示重点章节内容 or 相关章节内容 or 关键内容 or 相关内容。需要确保内容准确反应\"+ drug +\"在\"+ disease +\"诊断中的应用。（内容请丰富一些，请使用中文回答章节内容）)、" +
//                 "作者author、" +
//                 "发布时间publish、" +
//                 "发布机构organ，" +
//                 "以及该篇指南所在的具体可以追溯的路径url。" +
//                 "\n" +
//                 "返回的格式如下：" +
//                 "\n" +
//                 "1、严格按照JSON格式返回所有内容。" +
//                 "\n" +
//                 "2、使用 result 数组接收内容。" +
//                 "\n" +
//                 "3、针对每一篇指南使用一个对象接收，格式如下：" +
//                 "{\"title\": ..., \" content\": ..., \" author\": ..., \" url\": ..., \"  publish\": ..., \" organ\": ...}");
//         m2.put("role", "user");
//         message.add(m2);
//         req.put("messages", message);
//
// //        JSONObject format = new JSONObject();
// ////        format.put("type", "json_object");
// //        format.put("type", "text");
// //        req.put("response_format", format);
//
//         RequestBody body = RequestBody.create(MediaType.parse("application/json"), JSON.toJSONString(req));
//
//         Request request = new Request.Builder()
//                 .url(URL)
//                 .addHeader("Content-Type", "application/json")
//                 .addHeader("Authorization", "Bearer " + TOKEN)
//                 .post(body)
//                 .build();
//         //返回
//         List<GuideDS> guideDSResult = new ArrayList<>();
//         try (Response response = client.newCall(request).execute()) {
//             if (response.isSuccessful()) {
//                 ResponseBody responseBody = response.body();
//                 if (responseBody != null) {
//                     StringBuilder builder = new StringBuilder();
//                     InputStream inputStream = responseBody.byteStream();
//                     byte[] buffer = new byte[4096];
//                     int bytesRead;
//                     while ((bytesRead = inputStream.read(buffer)) != -1) {
//                         builder.append(new String(buffer, 0, bytesRead));
//                     }
//                     JSONObject jsonObject = JSONObject.parseObject(builder.toString());
//                     String resultResponse = jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
//                     if (StrUtil.isNotBlank(resultResponse)) {
//                         int start = resultResponse.indexOf('{');
//                         int end = resultResponse.lastIndexOf('}');
//                         String substring = resultResponse.substring(start, end + 1);
//                         substring = wiffOfContent(substring, "“", "\"");
//                         substring = wiffOfContent(substring, "”", "\"");
//                         JSONObject obj = JSONObject.parseObject(substring);
//                         JSONArray result = obj.getJSONArray("result");
//                         result.forEach(o -> {
//                             GuideDS guideDS = JSON.parseObject(JSON.toJSONString(o), GuideDS.class);
//                             guideDSResult.add(guideDS);
//                         });
//                     }
//                 }
//             } else {
//                 log.error("请求异常:{} ", response);
//             }
//         } catch (IOException e) {
//             log.error(e.getMessage(), e);
//             return new ArrayList<>();
//         }
//         ArrayList<GuideVO> guideVOS = new ArrayList<>();
//         if (guideDSResult.size() > 0) {
//             for (GuideDS guideDS : guideDSResult) {
//                 GuideVO guideVO = new GuideVO();
//                 guideVO.setTitle(guideDS.getTitle());
//                 guideVO.setPdf_txt(guideDS.getContent());
//                 guideVO.setZdz(guideDS.getOrgan());
//                 guideVO.setFbdate(guideDS.getPublish());
//                 guideVOS.add(guideVO);
//             }
//         }
//         log.info("searchGuideTop5:{}", guideVOS);
        ArrayList<GuideVO> guideVOS = new ArrayList<>();
        return guideVOS;
    }

    @Override
    public String getGpt(String gpt, String model,String score) {
        // if (StringUtils.isEmpty(model)) {
        //     model = "gpt-4o-mini";
        // }

        if (StringUtils.isNotEmpty(score)){
            String[] split = score.split(",");
            String list = Arrays.stream(split).map(item -> "\"" + item + "\"").collect(Collectors.joining(","));
            gpt += "*****得分相关的返回必须是"+list+"中的某个数值，不可以出现不存在的数值";
        }

        return gptAiUtils.youyideyi(gpt, null, model);
    }


    @Override
    public String getGptx(String gpt, String model, JSONObject jsonObject1) {
        if (StringUtils.isEmpty(model)) {
            model = "gpt-4o-mini";
        }
        return youyideyi(gpt, jsonObject1, model);
    }


    // ###########################sdy#################################


    @Override
    public JSONObject sdyPanel(String drugInfo, String disease, String id, String priceId, String specifications, String isCustom, long userId, String drugId, String searchId) {
        JSONObject result = new JSONObject();
        int step = 0;
        String[] arr = drugInfo.split("-");
        String drugName = arr[0];
        String enterpirceName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];

        result.put("ts", System.currentTimeMillis());
        result.put("disease", disease);
        result.put("cache_key", drugInfo + "_" + disease);

        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
        if (!GetSynonymUtil.judgeChinese(drugInfo)) {
            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
        }
        EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName)), EvidenceMesh.class, synonymTable);
        List<String> entryTerms = new ArrayList<>();
        if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
            entryTerms = evidenceMesh.getEntryTerms();
        }

        DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("id").is(drugId)), DrugInfoNew.class);
        if (drugInfo1 == null) {
            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
        }
        DrugAddDto drugAdd = null;
        if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
            drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
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


            }
        }

        // 合理用药
        if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
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

                if (StringUtils.isNotEmpty(evaluationMedicine.getString("blackBoxWaringOfFDA"))) {
                    drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("blackBoxWaringOfFDA")));
                }


            }
        }

        // 药品添加说明书
        if (ObjectUtil.isNotEmpty(drugAdd)) {
            BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
            StringBuilder usageAndDosage = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
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

        } else {
            drugAdd = new DrugAddDto();
        }

        // 获取检索时所填的信息
        JSONObject drugData = mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId)), JSONObject.class, "drug_data_sdy");
        if (ObjectUtil.isNotEmpty(drugData)) {

            // 说明书
            JSONArray list = drugData.getJSONArray("list");
            for (JSONObject jsonObject : list.toJavaList(JSONObject.class)) {
                if (drugInfo1.getId().equals(jsonObject.getString("drugId")) && disease.equals(jsonObject.getString("disease"))) {
                    DrugDisSdy drugDisSdy = JSONObject.parseObject(jsonObject.toJSONString(), DrugDisSdy.class);
                    drugInfo1.setSeriousAdverseRactions(drugDisSdy.getAdverseReaction());
                    drugInfo1.setSafeAdvantage(drugDisSdy.getSafeAdvantage());
                    drugInfo1.setTreatmentAdvantage(drugDisSdy.getTreatmentAdvantage());
                    drugInfo1.setGuidelinesVo(drugDisSdy.getGuide());
                    drugInfo1.setIngredient(drugDisSdy.getComponent());

                }
            }


        }
        String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();

        List<String> stringBuilder = new ArrayList<>();
        addProcess(id, step++, "<p class='text_title'>基于苏大一标准(抗菌药物遴选)，对" + drugNameDetail + "治疗" + disease + "疾病进行临床综合评价：</p>", stringBuilder);
        disease = disease.trim();
        List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
        List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

        GetSynonyms(drugName, drugs, disease, diseases);

        // 此处存储的key 与 value 的值在获取同义词接口出保存
        String redis_key = "synonym:" + userId;
        String synonym = RedisUtils.getStr(redis_key);
        if (StrUtil.isNotBlank(synonym)) {
            List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {
            });
            for (SynonymVo synonymVo : synonymVos) {
                // 表明输入词有药
                if (Integer.parseInt(synonymVo.getType()) == 1) {
                    // 要所有已勾选的同义词
                    drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
                    // 排除所有反勾选的同义词
                    drugs.removeAll(synonymVo.getExcludeSynonyms());
                }

                // 如果在研究疾病清单处自定义疾病  那么前一个页面中如果自定义了同义词就不再使用 否则需要使用自定义的同义词
                if (Integer.parseInt(isCustom) == 0) {
                    if (Integer.parseInt(synonymVo.getType()) == 3) {
                        // 要所有已勾选的同义词
                        diseases = new ArrayList<>(CollUtil.union(diseases, synonymVo.getSynonyms()));
                        // 排除所有反勾选的同义词
                        diseases.removeAll(synonymVo.getExcludeSynonyms());
                    }
                }
            }
        }


        long begin = System.currentTimeMillis();

        Map<String, Future<Boolean>> futureResult_sdy = new HashMap<>();
        Map<String, JSONObject> gptAnalysisMap_sdy = new HashMap<>();
        List<GuideDto> guideEffectiveMap_sdy = new ArrayList<>();
        Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy = new HashMap<>();

        useThreadPoolExecutePrompt_sdyPc(drugName, disease, drugInfo1, futureResult_sdy, gptAnalysisMap_sdy, guideEffectiveMap_sdy, guideOldEffectiveMap_sdy, drugAdd, drugs, diseases);

        // 安全性模块
        step = safetyAnalysis_sdy(drugName, disease, drugInfo1, step, id, result, futureResult_sdy, gptAnalysisMap_sdy, drugAdd, stringBuilder);

        // 有效性
        step = effectiveAnalysis_sdyPc(drugName, disease, drugInfo1, step, id, result, futureResult_sdy, gptAnalysisMap_sdy, guideEffectiveMap_sdy, guideOldEffectiveMap_sdy, stringBuilder);

        // 适宜性
        step = suitabilityAnalysis_sdy(drugName, disease, drugInfo1, futureResult_sdy, gptAnalysisMap_sdy, step, id, result, stringBuilder);

        // 可及性
        step = accessibilityAnalysis_sdy(drugInfo1, step, result);

        // 经济性
        step = economicalAnalysis_sdy(drugName, drugInfo1, step, result, enterpirceName, entryTerms, stringBuilder);


        // 第一部分 总体概括
        try {
            JSONObject overallSummary = new JSONObject();
            overallSummary.put("targetDrug", drugName);
            Integer summaryVScore = 0;
            summaryVScore += result.getJSONObject("safety").getInteger("vscore");
            summaryVScore += result.getJSONObject("suitability").getInteger("vscore");
            summaryVScore += result.getJSONObject("effectiveness").getInteger("vscore");
            result.put("overallSummary", overallSummary);
            overallSummary.put("comprehensiveScore", formatScore(summaryVScore.toString()));
            overallSummary.put("dimensionDiagram", new JSONArray());
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("max", 34);
            jsonObject1.put("name", "安全性");
            jsonObject1.put("value", result.getJSONObject("safety").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
            JSONObject jsonObject2 = new JSONObject();
            jsonObject2.put("max", 48);
            jsonObject2.put("name", "有效性");
            jsonObject2.put("value", result.getJSONObject("effectiveness").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
            JSONObject jsonObject3 = new JSONObject();
            jsonObject3.put("max", 18);
            jsonObject3.put("name", "适宜性");
            jsonObject3.put("value", result.getJSONObject("suitability").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
            JSONObject jsonObject4 = new JSONObject();
            jsonObject4.put("max", 10);
            jsonObject4.put("name", "可及性");
            jsonObject4.put("value", 0);
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
            JSONObject jsonObject5 = new JSONObject();
            jsonObject5.put("max", 10);
            jsonObject5.put("name", "经济性");
            jsonObject5.put("value", 0);
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
        String uuid = cn.hutool.core.lang.UUID.randomUUID(true).toString(true);
        result.put("id", uuid);
        result.put("_id", uuid);
        result.put("drugName", drugName);
        result.put("disease", disease);
        result.put("drugInfo", drugInfo);

        StringBuilder drugInfoSB = new StringBuilder();
        if (StrUtil.isNotBlank(drugName)) {
            drugInfoSB.append(drugName).append("-");
        }
        if (StrUtil.isNotBlank(specifications)) {
            drugInfoSB.append(specifications).append("-");
        }
        if (StrUtil.isNotBlank(enterpirceName)) {
            drugInfoSB.append(enterpirceName);
        }
        drugInfo = drugInfoSB.toString();
        result.put("drugInfo", drugInfo);

        this.mongoTemplate.insert(result, "drug_analyze_data");
        addProcess(id, step, "-END-", stringBuilder);
        log.info("pc端 苏一大 执行总时长{}", System.currentTimeMillis() - begin);
        return result;
    }

    private void useThreadPoolExecutePrompt_sdy(String drugName, String disease, DrugInfoNew drugInfo, Map<String, Future<Boolean>> futureResult_sdy, Map<String, JSONObject> gptAnalysisMap_sdy,
                                                Map<GuideVO, JSONObject> guideEffectiveMap_sdy, Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy, DrugAddDto drugAdd, List<String> drugs, List<String> diseases) {
        Future<Boolean> specialCrowd_pregnantWomen_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.3 孕妇可用或哺乳期妇女可用
            long begin_specialCrowd_pregnantWomen_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_pregnantWomen_sdy = new JSONObject();
            try {
                specialCrowd_pregnantWomen_sdy = this.specialCrowd_pregnantWomen_sdy(drugName, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_pregnantWomen_sdy.getString("score") == null) {
                    specialCrowd_pregnantWomen_sdy.put("score", 0);
                }
                if (specialCrowd_pregnantWomen_sdy.getString("process") == null) {
                    specialCrowd_pregnantWomen_sdy.put("process", "");
                }
            }
            log.info("specialCrowd_childrenMedicine_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_pregnantWomen_sdy", specialCrowd_pregnantWomen_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_pregnantWomen_sdy", specialCrowd_pregnantWomen_sdy_Result);


        Future<Boolean> specialCrowd_liver_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.4 重度肝功能异常可用
            long begin_specialCrowd_liver_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_liver_sdy = new JSONObject();
            try {
                specialCrowd_liver_sdy = this.specialCrowd_liver_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_liver_sdy.getString("score") == null) {
                    specialCrowd_liver_sdy.put("score", 0);
                }
                if (specialCrowd_liver_sdy.getString("process") == null) {
                    specialCrowd_liver_sdy.put("process", "");
                }
                if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    specialCrowd_liver_sdy.put("process", "未找到肝功能不全者剂量调整信息");
                    specialCrowd_liver_sdy.put("score", 2);
                } else {
                    specialCrowd_liver_sdy.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction());
                }
            }
            log.info("specialCrowd_liver_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liver_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_liver_sdy", specialCrowd_liver_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_liver_sdy", specialCrowd_liver_sdy_Result);

        Future<Boolean> specialCrowd_kidney_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.4 重度肾功能异常可用
            long begin_specialCrowd_kidney_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_kidney_sdy = new JSONObject();
            try {
                specialCrowd_kidney_sdy = this.specialCrowd_kidney_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_kidney_sdy.getString("score") == null) {
                    specialCrowd_kidney_sdy.put("score", 0);
                }
                if (specialCrowd_kidney_sdy.getString("process") == null) {
                    specialCrowd_kidney_sdy.put("process", "");
                }

                if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    specialCrowd_kidney_sdy.put("process", "未找到肾功能不全者剂量调整信息");
                    specialCrowd_kidney_sdy.put("score", 2);
                } else {
                    specialCrowd_kidney_sdy.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction());
                }
            }
            log.info("specialCrowd_kidney_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_kidney_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_kidney_sdy", specialCrowd_kidney_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_kidney_sdy", specialCrowd_kidney_sdy_Result);

        Future<Boolean> pharmacovigilance_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.4 药物警戒
            long begin_pharmacovigilance_sdy = System.currentTimeMillis();
            JSONObject pharmacovigilance_sdy = new JSONObject();
            try {
                pharmacovigilance_sdy = this.pharmacovigilance_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (pharmacovigilance_sdy.getString("score") == null) {
                    pharmacovigilance_sdy.put("score", 0);
                }
                if (pharmacovigilance_sdy.getString("process") == null) {
                    pharmacovigilance_sdy.put("process", "暂无内容");
                }
            }
            log.info("pharmacovigilance_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacovigilance_sdy);

            gptAnalysisMap_sdy.put("pharmacovigilance_sdy", pharmacovigilance_sdy);
            return true;
        });
        futureResult_sdy.put("pharmacovigilance_sdy", pharmacovigilance_sdy_Result);


        Future<Boolean> advantageResult = gptAnalysisThreadPool.submit(() -> {
            // 优势
            long begin_advantage = System.currentTimeMillis();
            JSONObject advantage = new JSONObject();
            try {
                advantage = this.advantage_sdy(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (advantage.getString("score") == null) {
                    advantage.put("score", 0);
                }
                if (advantage.getString("process") == null) {
                    advantage.put("process", "");
                }

            }
            log.info("advantage  gpt  分析时长{}", System.currentTimeMillis() - begin_advantage);


            gptAnalysisMap_sdy.put("advantage", advantage);
            return true;
        });
        futureResult_sdy.put("advantage", advantageResult);


        Future<Boolean> suitScore_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            long begin_suitScore_sdy = System.currentTimeMillis();
            JSONObject suitScore_sdy = new JSONObject();
            try {
                suitScore_sdy = this.sdySuitScore_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            log.info("suitScore_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_suitScore_sdy);

            gptAnalysisMap_sdy.put("suitScore_sdy", suitScore_sdy);
            return true;
        });
        futureResult_sdy.put("suitScore_sdy", suitScore_sdy_Result);


        Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
            // 指南筛选
            List<GuideVO> guideVOList = queryGuideByDrugAndDisease(drugs, drugInfo.getDrugZh(), diseases, disease);


            // 前2篇指南的筛选
            for (int i = 0; i < guideVOList.size(); i++) {
                int trail = i + 1;
                GuideVO guideVO = guideVOList.get(i);
                Future<Boolean> guideResult_trail = gptAnalysisThreadPool.submit(() -> {
                    long begin_guide = System.currentTimeMillis();
                    JSONObject guide = new JSONObject();
                    try {
                        String pdf_txt = guideVO.getPdf_txt();
                        String zdz = guideVO.getZdz();
                        String title = guideVO.getTitle();
                        guide = this.guide_sdy(drugName, disease, pdf_txt, title, zdz, drugInfo);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guide.getString("score") == null) {
                            guide.put("score", 0);
                        }
                        if (guide.getString("process") == null) {
                            guide.put("process", "");
                        }
                    }
                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);

                    guideEffectiveMap_sdy.put(guideVO, guide);
                    return true;
                });
                futureResult_sdy.put("mainGuide_" + trail, guideResult_trail);
            }
            return true;
        });
        futureResult_sdy.put("guideResult", guideResult);
    }


    private void useThreadPoolExecutePrompt_sdyPc(String drugName, String disease, DrugInfoNew drugInfo, Map<String, Future<Boolean>> futureResult_sdy, Map<String, JSONObject> gptAnalysisMap_sdy,
                                                  List<GuideDto> guideEffectiveMap_sdy, Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy, DrugAddDto drugAdd, List<String> drugs, List<String> diseases) {
        Future<Boolean> specialCrowd_pregnantWomen_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.3 孕妇可用或哺乳期妇女可用
            long begin_specialCrowd_pregnantWomen_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_pregnantWomen_sdy = new JSONObject();
            try {
                specialCrowd_pregnantWomen_sdy = this.specialCrowd_pregnantWomen_sdy(drugName, drugInfo, drugAdd);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_pregnantWomen_sdy.getString("score") == null) {
                    specialCrowd_pregnantWomen_sdy.put("score", 0);
                }
                if (specialCrowd_pregnantWomen_sdy.getString("process") == null) {
                    specialCrowd_pregnantWomen_sdy.put("process", "");
                }
            }
            log.info("specialCrowd_childrenMedicine_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_pregnantWomen_sdy", specialCrowd_pregnantWomen_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_pregnantWomen_sdy", specialCrowd_pregnantWomen_sdy_Result);


        Future<Boolean> specialCrowd_liver_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.4 重度肝功能异常可用
            long begin_specialCrowd_liver_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_liver_sdy = new JSONObject();
            try {
                specialCrowd_liver_sdy = this.specialCrowd_liver_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_liver_sdy.getString("score") == null) {
                    specialCrowd_liver_sdy.put("score", 0);
                }
                if (specialCrowd_liver_sdy.getString("process") == null) {
                    specialCrowd_liver_sdy.put("process", "");
                }
                if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    specialCrowd_liver_sdy.put("process", "未找到肝功能不全者剂量调整信息");
                    specialCrowd_liver_sdy.put("score", 2);
                } else {
                    specialCrowd_liver_sdy.put("process", drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction());
                }
            }
            log.info("specialCrowd_liver_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liver_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_liver_sdy", specialCrowd_liver_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_liver_sdy", specialCrowd_liver_sdy_Result);

        Future<Boolean> specialCrowd_kidney_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.3.4 重度肾功能异常可用
            long begin_specialCrowd_kidney_sdy = System.currentTimeMillis();
            JSONObject specialCrowd_kidney_sdy = new JSONObject();
            try {
                specialCrowd_kidney_sdy = this.specialCrowd_kidney_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_kidney_sdy.getString("score") == null) {
                    specialCrowd_kidney_sdy.put("score", 0);
                }
                if (specialCrowd_kidney_sdy.getString("process") == null) {
                    specialCrowd_kidney_sdy.put("process", "");
                }

                if (StringUtils.isEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    specialCrowd_kidney_sdy.put("process", "未找到肾功能不全者剂量调整信息");
                    specialCrowd_kidney_sdy.put("score", 2);
                } else {
                    specialCrowd_kidney_sdy.put("process", drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency());
                }
            }
            log.info("specialCrowd_kidney_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_kidney_sdy);

            gptAnalysisMap_sdy.put("specialCrowd_kidney_sdy", specialCrowd_kidney_sdy);
            return true;
        });
        futureResult_sdy.put("specialCrowd_kidney_sdy", specialCrowd_kidney_sdy_Result);

        Future<Boolean> pharmacovigilance_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            // 1.4 药物警戒
            long begin_pharmacovigilance_sdy = System.currentTimeMillis();
            JSONObject pharmacovigilance_sdy = new JSONObject();
            try {
                pharmacovigilance_sdy = this.pharmacovigilance_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (pharmacovigilance_sdy.getString("score") == null) {
                    pharmacovigilance_sdy.put("score", 0);
                }
                if (pharmacovigilance_sdy.getString("process") == null) {
                    pharmacovigilance_sdy.put("process", "暂无内容");
                }
            }
            log.info("pharmacovigilance_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacovigilance_sdy);

            gptAnalysisMap_sdy.put("pharmacovigilance_sdy", pharmacovigilance_sdy);
            return true;
        });
        futureResult_sdy.put("pharmacovigilance_sdy", pharmacovigilance_sdy_Result);


        Future<Boolean> advantageResult = gptAnalysisThreadPool.submit(() -> {
            // 优势
            long begin_advantage = System.currentTimeMillis();
            JSONObject advantage = new JSONObject();
            try {
                advantage = this.advantage_sdy(drugName, disease, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (advantage.getString("score") == null) {
                    advantage.put("score", 0);
                }
                if (advantage.getString("process") == null) {
                    advantage.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getTreatmentAdvantage())) {
                    advantage.put("process", drugInfo.getTreatmentAdvantage());
                }
            }
            log.info("advantage  gpt  分析时长{}", System.currentTimeMillis() - begin_advantage);


            gptAnalysisMap_sdy.put("advantage", advantage);
            return true;
        });
        futureResult_sdy.put("advantage", advantageResult);


        Future<Boolean> suitScore_sdy_Result = gptAnalysisThreadPool.submit(() -> {
            long begin_suitScore_sdy = System.currentTimeMillis();
            JSONObject suitScore_sdy = new JSONObject();
            try {
                suitScore_sdy = this.sdySuitScore_sdy(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            log.info("suitScore_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_suitScore_sdy);

            gptAnalysisMap_sdy.put("suitScore_sdy", suitScore_sdy);
            return true;
        });
        futureResult_sdy.put("suitScore_sdy", suitScore_sdy_Result);


        Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
            // 指南筛选

            List<GuidelinesVo> guideVOList = drugInfo.getGuidelinesVo();


            // 前2篇指南的筛选
            for (int i = 0; i < guideVOList.size(); i++) {
                int trail = i + 1;
                GuidelinesVo guideVO = guideVOList.get(i);
                GuideDto guideDto = new GuideDto();
                guideDto.setGuidelines(guideVO);
                guideEffectiveMap_sdy.add(guideDto);
                Future<Boolean> guideResult_trail = gptAnalysisThreadPool.submit(() -> {
                    long begin_guide = System.currentTimeMillis();
                    JSONObject guide = new JSONObject();
                    try {
                        String pdf_txt = guideVO.getContent();
                        String title = guideVO.getShowField();
                        guide = this.guide_sdyPc(drugName, disease, pdf_txt, title, drugInfo);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    } finally {
                        if (guide.getString("score") == null) {
                            guide.put("score", 0);
                        }
                        if (guide.getString("process") == null) {
                            guide.put("process", "");
                        }
                        guideDto.setGuide(guide);
                    }
                    log.info("guide  gpt  分析时长{}", System.currentTimeMillis() - begin_guide);


                    return true;
                });
                futureResult_sdy.put("mainGuide_" + trail, guideResult_trail);
            }
            return true;
        });
        futureResult_sdy.put("guideResult", guideResult);
    }


    private int economicalAnalysis_sdy(String drugName, DrugInfoNew drugInfo1, int step, JSONObject result, String enterpirceName, List<String> entryTerms, List<String> stringBuilder) {
        // 第六部分 药品综合评价之经济性
        result.put("time", DateUtil.formatDateTime(new Date()));
        try {
            // addProcess(id,step++,"开始进行经济性评分");
            JSONObject economical = new JSONObject();
            result.put("economical", economical);

            List<DrugInfoDeduplication> drugAndPriceListx = this.mongoTemplate.find(new Query(Criteria.where("drugName").is(drugName).and("unitPrice").exists(true)), DrugInfoDeduplication.class);
            Set<DrugInfoDeduplication> drugAndPriceList = new LinkedHashSet<>(drugAndPriceListx);
            economical.put("summarize", "主要从同类药品经济性情况分析药品的经济性");
            economical.put("manufacturerList", new JSONArray());
            economical.put("similarDrugsList", new JSONArray());
            economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产厂家", "单位价格", "价格中位值（元）")));
            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产厂家", "单位价格", "价格中位值（元）")));
            List<Double> priceList = new ArrayList<>();
            Double midPrice = 0d;
            for (DrugInfoDeduplication drugAndPrice : drugAndPriceList) {

                if (StrUtil.isNotBlank(drugAndPrice.getUnitPrice())) {
                    priceList.add(Double.parseDouble(drugAndPrice.getUnitPrice()));
                }

            }

            Collections.sort(priceList);
            if (CollectionUtil.isNotEmpty(priceList)) {
                midPrice = priceList.get((priceList.size() + 1) / 2);
            }


            for (DrugInfoDeduplication drugAndPrice : drugAndPriceList) {

                if (StrUtil.isNotBlank(drugAndPrice.getUnitPrice())) {
                    priceList.add(Double.parseDouble(drugAndPrice.getUnitPrice()));
                    economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getRatio(), drugAndPrice.getUnit(), drugAndPrice.getManufacturer(), new BigDecimal(drugAndPrice.getUnitPrice()).setScale(2, BigDecimal.ROUND_HALF_UP), new BigDecimal(midPrice).setScale(2, BigDecimal.ROUND_HALF_UP))));
                }

            }




                /*List<JSONObject> jsonObjects = this.mongoTemplate.find(new Query(Criteria.where("四级中文").in(one.getJSONArray("words")).and("五级中文").ne(drugName)), JSONObject.class, "drug_5_class");
                for (JSONObject jsonObject : jsonObjects) {
                    DrugAndPrice drugAndPrices = this.mongoTemplate.findOne(new Query(Criteria.where("drugName").is(jsonObject.getString("五级中文"))), DrugAndPrice.class);
                    if (drugAndPrices == null) {
                        continue;
                    }
                    economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList(drugAndPrices.getDrugName(), drugAndPrices.getSpecifications(), "", "", drugAndPrices.getManufacturer(), drugAndPrices.getBidWinningPrice(), "", "")));
                }*/
            // 其他同类药物推荐
            Query query1 = new Query(Criteria.where("word").is(drugInfo1.getDrugZh()));
            query1.with(Sort.by(Sort.Direction.DESC, "codeLevel"));
            List<GradeAndDrugs> gradeAndDrugs = mongoTemplate.find(query1, GradeAndDrugs.class);
            ArrayList<String> strings = new ArrayList<>();
            if (CollectionUtil.isNotEmpty(gradeAndDrugs)) {
                for (GradeAndDrugs gradeAndDrug : gradeAndDrugs) {
                    if (gradeAndDrug.getCodeLevel() == 4) {
                        strings.add(gradeAndDrug.getCode().substring(0, gradeAndDrug.getCode().length() - 3));
                    }
                }
            }

            Criteria orCriteria = new Criteria().orOperator(
                    strings.stream()
                            .map(regex -> Criteria.where("code").regex(regex))
                            .toArray(Criteria[]::new)
            );
            Criteria additionalCriteria = Criteria.where("word").ne(drugInfo1.getDrugZh());
            Criteria criteria = new Criteria().andOperator(orCriteria, additionalCriteria);
            Query query = new Query(criteria);
            List<GradeAndDrugs> gradeAndDrugs1 = mongoTemplate.find(query, GradeAndDrugs.class);
            if (CollectionUtil.isEmpty(gradeAndDrugs1) || gradeAndDrugs1.size() < 1) {
                for (GradeAndDrugs gradeAndDrug : gradeAndDrugs) {
                    strings.add(gradeAndDrug.getCode().substring(0, gradeAndDrug.getCode().length() - 7));
                }

                Criteria orCriteria1 = new Criteria().orOperator(
                        strings.stream()
                                .map(regex -> Criteria.where("code").regex(regex))
                                .toArray(Criteria[]::new)
                );
                Criteria additionalCriteria1 = Criteria.where("word").ne(drugInfo1.getDrugZh());
                Criteria criteria1 = new Criteria().andOperator(orCriteria1, additionalCriteria1);
                Query query2 = new Query(criteria1);
                gradeAndDrugs1 = mongoTemplate.find(query2, GradeAndDrugs.class);
            }

            if (ObjectUtil.isNotEmpty(gradeAndDrugs1) && gradeAndDrugs1.size() > 0) {
                ArrayList<String> strings1 = new ArrayList<>();
                for (GradeAndDrugs gradeAndDrug : gradeAndDrugs1) {
                    strings1.addAll(gradeAndDrug.getWord());
                }
                List<DrugInfoDeduplication> drugAndPriceLists = this.mongoTemplate.find(new Query(Criteria.where("drugZh").in(strings1).and("drugName").ne(drugName).and("unitPrice").exists(true)), DrugInfoDeduplication.class);
                Set<DrugInfoDeduplication> drugAndPriceList1 = new LinkedHashSet<>(drugAndPriceLists);
                List<Double> priceList1 = new ArrayList<>();
                Double midPrice1 = 0d;
                for (DrugInfoDeduplication drugAndPrice : drugAndPriceList1) {
                    if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                        if (StrUtil.isNotBlank(drugAndPrice.getUnitPrice())) {
                            priceList1.add(Double.parseDouble(drugAndPrice.getUnitPrice()));
                        }
                    }
                }

                Collections.sort(priceList1);
                if (CollectionUtil.isNotEmpty(priceList1)) {
                    midPrice1 = priceList1.get((priceList1.size() + 1) / 2);
                }
                for (DrugInfoDeduplication drugAndPrice : drugAndPriceList1) {
                    if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                        if (StrUtil.isNotBlank(drugAndPrice.getUnitPrice())) {
                            priceList.add(Double.parseDouble(drugAndPrice.getUnitPrice()));
                            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getRatio(), drugAndPrice.getUnit(), drugAndPrice.getManufacturer(), new BigDecimal(drugAndPrice.getUnitPrice()).setScale(2, BigDecimal.ROUND_HALF_UP), new BigDecimal(midPrice1).setScale(2, BigDecimal.ROUND_HALF_UP))));
                        }
                    }
                }
            }

        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return step;
    }


    private int accessibilityAnalysis_sdy(DrugInfoNew drugInfo, int step, JSONObject result) {
        JSONObject access = new JSONObject();
        result.put("accessibility", access);
        access.put("summarize", "主要从国家基本药物收录情况以及国家医保目录收录情况两方面分析药品的可及性");

        // 支付限制
        access.put("paymentLimits", false);
        access.put("paymentLimit", "");
        if (drugInfo != null && StringUtils.isNotBlank(drugInfo.getPaymentScope())) {
            access.put("paymentLimits", true);
            access.put("paymentLimit", drugInfo.getPaymentScope());
        }
        access.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo.getPaymentScope()) ? drugInfo.getPaymentScope() : "");
        // 基本药物
        access.put("essentialMedicines", false);
        if (drugInfo != null && StrUtil.equals(drugInfo.getEssentialMedicines(), "是")) {
            access.put("essentialMedicines", true);
        }
        // 有无△要求
        String essentialType = drugInfo.getEssentialType();
        access.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
        // 医保情况
        if (drugInfo != null && StrUtil.isNotBlank(drugInfo.getMedicalInsurance())) {
            access.put("reimbursement", drugInfo.getMedicalInsurance());
            access.put("reimbursementList", true);
        } else {
            access.put("reimbursement", "");
            access.put("reimbursementList", false);
        }
        // 是否列为国家集中采购药品
        boolean isConcentrate = true;
        String drugCollection = drugInfo.getDrugCollection();
        if ("本品非集采药品。".equals(drugCollection)) {
            isConcentrate = false;
        }
        access.put("procurementOfDrugs", isConcentrate);

        return step;
    }

    private int suitabilityAnalysis_sdy(String drugName, String disease, DrugInfoNew drugInfo, Map<String, Future<Boolean>> futureResult_sdy,
                                        Map<String, JSONObject> gptAnalysisMap_sdy, int step, String id, JSONObject result, List<String> stringBuilder) {
        // 第四部分 药品综合评价之适宜性
        addProcess(id, step++, "<b>3、适宜性</b>", stringBuilder);
        addProcess(id, step++, "主要从使用方法/依从性（4分）、贮藏条件（4分）、复方制剂的成分及配比是否规范（6分）以及皮试要求（4分）四方面考察药品的适宜性。", stringBuilder);
        JSONObject suitRes = new JSONObject();
        result.put("suitability", suitRes);

        float skinScore = 0f;
        String skinTestSituation = "";
        if (drugInfo != null) {
            String skinTest = drugInfo.getSkinTest();
            skinTestSituation = skinTest;
            if (StringUtils.isNotEmpty(skinTest)) {
                if (skinTest.contains("不")) {
                    skinScore = 4;
                }
            }

        }

//        long begin_suitScore_sdy = System.currentTimeMillis();
//        JSONObject suitScore_sdy = new JSONObject();
//        try {
//            suitScore_sdy = this.sdySuitScore_sdy(drugName, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//        log.info("suitScore_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_suitScore_sdy);

        JSONObject suitScore_sdy = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("suitScore_sdy"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("suitScore_sdy").get();
                if (isSuccess) {
                    suitScore_sdy = gptAnalysisMap_sdy.get("suitScore_sdy");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        float suitVScore = 0f;
        suitVScore += skinScore;
        for (Map.Entry<String, Object> entry : suitScore_sdy.entrySet()) {
            if (!entry.getKey().contains("得分理由") && !entry.getKey().contains("msg")) {
                try {
                    suitVScore += Float.parseFloat(entry.getValue().toString());
                } catch (NumberFormatException e) {
                    log.error(entry.getValue().toString());
                }
            }
        }

        suitRes.put("score", "适宜性得分：" + formatNumber(suitVScore) + "分");
        suitRes.put("vscore", formatNumber(suitVScore));
        suitRes.put("summarize", "总分18分，主要从使用方法/依从性（4分）、贮藏条件（4分）、复方制剂的成分及配比是否规范（6分）以及皮试要求（4分）四方面考察药品的适宜性。");
        suitRes.put("skinScore", formatNumber(skinScore));
        suitRes.put("usageMethodScore", formatScore(suitScore_sdy.getString("使用方法")));
        suitRes.put("compositionRatio", formatScore(suitScore_sdy.getString("复方成分")));
        suitRes.put("storageScore", formatScore(suitScore_sdy.getString("贮藏条件")));
        // suitRes.put("skinScore",suitScore.getString("皮试要求"));

        suitRes.put("details", new JSONObject());
        suitRes.getJSONObject("details").put("skinTestSituation", skinTestSituation);
        suitRes.getJSONObject("details").put("usageMethod", suitScore_sdy.getString("使用方法msg"));
        suitRes.getJSONObject("details").put("proportioningSituation", StringUtils.isNotEmpty(drugInfo.getIngredient()) ?
                drugInfo.getIngredient() : suitScore_sdy.getString("复方成分msg"));
        suitRes.getJSONObject("details").put("storageConditions", suitScore_sdy.getString("贮藏条件msg"));
        // suitRes.getJSONObject("details").put("skinTestSituation",suitScore.getString("皮试要求msg"));

        addProcess(id, step++, "（1）使用方法/依从性：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo.getUsageAndDosage()) ? drugInfo.getUsageAndDosage() : suitScore_sdy.getString("使用方法msg")), stringBuilder);
        addProcess(id, step++, "（2）贮藏条件：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo.getStorage()) ? drugInfo.getStorage() : suitScore_sdy.getString("贮藏条件msg")), stringBuilder);
        addProcess(id, step++, "（3）复方制剂：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo.getIngredient()) ? drugInfo.getIngredient() : suitScore_sdy.getString("复方成分msg")), stringBuilder);
        addProcess(id, step++, "（4）皮试：", stringBuilder);
        // addProcess(id,step ++,formatInfo(suitScore.getString("皮试要求msg")));
        addProcess(id, step++, formatInfo(skinTestSituation), stringBuilder);
        return step;
    }

    private int effectiveAnalysis_sdy(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult_sdy, Map<String, JSONObject> gptAnalysisMap_sdy, Map<GuideVO, JSONObject> guideEffectiveMap_sdy,
                                      Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy, List<String> stringBuilder) {
        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        addProcess(id, step++, "主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。", stringBuilder);

        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("table", new JSONArray());
        effective.put("summarize", "总分48分，主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。");
        addProcess(id, step++, "（1）证据推荐情况：", stringBuilder);

        effective.getJSONArray("table").add(Arrays.asList("指南名称", "发布机构", "发布日期", "相关内容"));
        effective.put("score", 0);
        effective.put("advantageScore", 0);
        effective.put("guideScore", 0);

//        int guideIndex = 0;
//        List<String> guideTitle = new  ArrayList<>();
//        // 2.2 指南
//        for (GuideVO guideVO : guideVOList) {
//            long begin_guide = System.currentTimeMillis();
//            JSONObject guide = new JSONObject();
//            try {
//                String pdf_txt = guideVO.getPdf_txt();
//                guide = this.guide_sdy(drugName, disease, pdf_txt);
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
//            if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                guideIndex++;
//                continue;
//            }
//
////            addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//            guideTitle.add("《"+guideVO.getTitle()+"》");
//            if(effective.getInteger("guideScore")==0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
//                effective.put("guideScore", guide.getString("score"));
//            }
//
//            JSONArray jsonArray1 = new JSONArray();
//            jsonArray1.add(guideVO.getTitle());
//            jsonArray1.add(guideVO.getZdz());
//            jsonArray1.add(guideVO.getFbdate());
//            jsonArray1.add("-");
//            jsonArray1.add(guide.getString("process"));
//            effective.getJSONArray("table").add(jsonArray1);
//        }
//
//        for (GuideVO guideVO : oldGuideVOList) {
//            if (guideIndex > 0) {
//                long begin_guide = System.currentTimeMillis();
//                JSONObject guide = new JSONObject();
//                try {
//                    String pdf_txt = guideVO.getPdf_txt();
//                    guide = this.guide_sdy(drugName, disease, pdf_txt);
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
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                    continue;
//                }
//
////                addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//                guideTitle.add("《"+guideVO.getTitle()+"》");
//                if(effective.getInteger("guideScore")==0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
//                    effective.put("guideScore", guide.getString("score"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(guideVO.getTitle());
//                jsonArray1.add(guideVO.getZdz());
//                jsonArray1.add(guideVO.getFbdate());
//                jsonArray1.add("-");
//                jsonArray1.add(guide.getString("process"));
//                effective.getJSONArray("table").add(jsonArray1);
//                guideIndex --;
//            }
//        }
//
//        if (CollUtil.isNotEmpty(guideTitle)) {
//            for (String title : guideTitle) {
//                addProcess(id,step++,title);
//            }
//        } else {
//            addProcess(id,step++,"暂无找到相关证据推荐。");
//        }

        List<String> guideTitle = new ArrayList<>();
        int guideIndex = 0;
        // 2.2 指南
        // 等待异步执行完毕
        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
            try {
                wait(1000);
            } catch (InterruptedException ex) {
                throw new RuntimeException(ex);
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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
            try {
                wait(1000);
            } catch (InterruptedException ex) {
                throw new RuntimeException(ex);
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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


        if (CollUtil.isNotEmpty(guideEffectiveMap_sdy)) {
            for (Map.Entry<GuideVO, JSONObject> guideVOJSONObjectEntry : guideEffectiveMap_sdy.entrySet()) {
                GuideVO guideVO = guideVOJSONObjectEntry.getKey();
                JSONObject guide = guideVOJSONObjectEntry.getValue();
                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
                    guideIndex++;
                    continue;
                }
                guideTitle.add("《" + guideVO.getTitle() + "》 —— " + guideVO.getZdz() + " —— " + guideVO.getFbdate());
                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
                    effective.put("guideScore", formatScore(guide.getString("score")));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(guideVO.getTitle());
                jsonArray1.add(guideVO.getZdz());
                jsonArray1.add(guideVO.getFbdate());
                jsonArray1.add(guide.getString("process"));
                effective.getJSONArray("table").add(jsonArray1);
            }
        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap_sdy)) {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "reserveGuide")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }

            int size = guideOldEffectiveMap_sdy.size();
            do {
                List<GuideVO> guideVOS = new ArrayList<>(guideOldEffectiveMap_sdy.keySet());
                GuideVO searchHit = guideVOS.get(size - 1);
                JSONObject guideEffective = guideOldEffectiveMap_sdy.get(searchHit);
                if (!StrUtil.isNumeric(guideEffective.getString("score")) || StrUtil.isBlank(guideEffective.getString("process"))) {
                    continue;
                }

                guideTitle.add("《" + searchHit.getTitle() + "》 —— " + searchHit.getZdz() + " —— " + searchHit.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("guideScore", formatScore(guideEffective.getString("score")));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add(guideEffective.getString("process"));
                effective.getJSONArray("table").add(jsonArray1);
            } while (--guideIndex > 0 && --size > 0);
        }

        if (CollUtil.isNotEmpty(guideTitle)) {
//            addProcess(id, step++, "&nbsp;&nbsp;&nbsp; 指南推荐：");
            for (String title : guideTitle) {
                addProcess(id, step++, title, stringBuilder);
            }
        } else {
            addProcess(id, step++, "暂未找到相关临床指南推荐。", stringBuilder);
        }

        // 优势
//        long begin_advantage = System.currentTimeMillis();
//        JSONObject advantage = new JSONObject();
//        try {
//            advantage = this.advantage_sdy(drugName, disease);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (advantage.getString("score") == null) {
//                advantage.put("score", 0);
//            }
//            if (advantage.getString("process") == null) {
//                advantage.put("process", "");
//            }
//        }
//        log.info("advantage  gpt  分析时长{}", System.currentTimeMillis() - begin_advantage);
//
        JSONObject advantage = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("advantage"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("advantage").get();
                if (isSuccess) {
                    advantage = gptAnalysisMap_sdy.get("advantage");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        addProcess(id, step++, "（2）与同类药品相比有效性性优势：", stringBuilder);
        addProcess(id, step++, formatInfo(advantage.getString("process")), stringBuilder);
        effective.put("advantage", advantage.getString("process"));
        effective.put("advantageScore", formatScore(advantage.getString("score")));

        float effectiveScore = 0f;
        try {
            effectiveScore += effective.getFloat("guideScore");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            effectiveScore += advantage.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        effective.put("score", "有效性得分：" + formatNumber(effectiveScore) + "分");
        effective.put("vscore", formatNumber(effectiveScore));

        return step;
    }


    private int effectiveAnalysis_sdyPc(String drugName, String disease, DrugInfoNew drugInfo1, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult_sdy, Map<String, JSONObject> gptAnalysisMap_sdy, List<GuideDto> guideEffectiveMap_sdy,
                                        Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy, List<String> stringBuilder) {
        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        addProcess(id, step++, "主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。", stringBuilder);

        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("guidePc", new JSONArray());
        effective.put("summarize", "总分48分，主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。");
        addProcess(id, step++, "（1）证据推荐情况：", stringBuilder);

        effective.put("score", 0);
        effective.put("advantageScore", 0);
        effective.put("guideScore", 0);

//        int guideIndex = 0;
//        List<String> guideTitle = new  ArrayList<>();
//        // 2.2 指南
//        for (GuideVO guideVO : guideVOList) {
//            long begin_guide = System.currentTimeMillis();
//            JSONObject guide = new JSONObject();
//            try {
//                String pdf_txt = guideVO.getPdf_txt();
//                guide = this.guide_sdy(drugName, disease, pdf_txt);
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
//            if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                guideIndex++;
//                continue;
//            }
//
////            addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//            guideTitle.add("《"+guideVO.getTitle()+"》");
//            if(effective.getInteger("guideScore")==0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
//                effective.put("guideScore", guide.getString("score"));
//            }
//
//            JSONArray jsonArray1 = new JSONArray();
//            jsonArray1.add(guideVO.getTitle());
//            jsonArray1.add(guideVO.getZdz());
//            jsonArray1.add(guideVO.getFbdate());
//            jsonArray1.add("-");
//            jsonArray1.add(guide.getString("process"));
//            effective.getJSONArray("table").add(jsonArray1);
//        }
//
//        for (GuideVO guideVO : oldGuideVOList) {
//            if (guideIndex > 0) {
//                long begin_guide = System.currentTimeMillis();
//                JSONObject guide = new JSONObject();
//                try {
//                    String pdf_txt = guideVO.getPdf_txt();
//                    guide = this.guide_sdy(drugName, disease, pdf_txt);
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
//                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
//                    continue;
//                }
//
////                addProcess(id,step++,"《"+guideVO.getTitle()+"》");
//                guideTitle.add("《"+guideVO.getTitle()+"》");
//                if(effective.getInteger("guideScore")==0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
//                    effective.put("guideScore", guide.getString("score"));
//                }
//
//                JSONArray jsonArray1 = new JSONArray();
//                jsonArray1.add(guideVO.getTitle());
//                jsonArray1.add(guideVO.getZdz());
//                jsonArray1.add(guideVO.getFbdate());
//                jsonArray1.add("-");
//                jsonArray1.add(guide.getString("process"));
//                effective.getJSONArray("table").add(jsonArray1);
//                guideIndex --;
//            }
//        }
//
//        if (CollUtil.isNotEmpty(guideTitle)) {
//            for (String title : guideTitle) {
//                addProcess(id,step++,title);
//            }
//        } else {
//            addProcess(id,step++,"暂无找到相关证据推荐。");
//        }

        List<String> guideTitle = new ArrayList<>();
        int guideIndex = 0;
        // 2.2 指南
        // 等待异步执行完毕
        try {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
            try {
                wait(1000);
            } catch (InterruptedException ex) {
                throw new RuntimeException(ex);
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "guideResult")) {
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
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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
            try {
                wait(1000);
            } catch (InterruptedException ex) {
                throw new RuntimeException(ex);
            }
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "mainGuide")) {
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


        if (CollUtil.isNotEmpty(guideEffectiveMap_sdy)) {
            for (GuideDto guideVOJSONObjectEntry : guideEffectiveMap_sdy) {
                GuidelinesVo guideVO = guideVOJSONObjectEntry.getGuidelines();
                JSONObject guide = guideVOJSONObjectEntry.getGuide();
                if (!StrUtil.isNumeric(guide.getString("score")) || StrUtil.isBlank(guide.getString("process"))) {
                    guide.put("score", "4");
                }
                guideTitle.add(guideVO.getShowField());
                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guide.getInteger("score")) {
                    effective.put("guideScore", formatScore(guide.getString("score")));
                }

                JSONObject jsonObject = new JSONObject();
                jsonObject.put("showField", guideVO.getShowField());
                jsonObject.put("content", guideVO.getContent());
                effective.getJSONArray("guidePc").add(jsonObject);
            }
        }

        if (guideIndex > 0 && CollUtil.isNotEmpty(guideOldEffectiveMap_sdy)) {
            for (Map.Entry<String, Future<Boolean>> futureEntry : futureResult_sdy.entrySet()) {
                if (StrUtil.startWith(futureEntry.getKey(), "reserveGuide")) {
                    Future<Boolean> guideResult = futureEntry.getValue();
                    try {
                        guideResult.get();
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }

            int size = guideOldEffectiveMap_sdy.size();
            do {
                List<GuideVO> guideVOS = new ArrayList<>(guideOldEffectiveMap_sdy.keySet());
                GuideVO searchHit = guideVOS.get(size - 1);
                JSONObject guideEffective = guideOldEffectiveMap_sdy.get(searchHit);
                if (!StrUtil.isNumeric(guideEffective.getString("score")) || StrUtil.isBlank(guideEffective.getString("process"))) {
                    continue;
                }

                guideTitle.add("《" + searchHit.getTitle() + "》 —— " + searchHit.getZdz() + " —— " + searchHit.getFbdate());

                if (effective.getInteger("guideScore") == 0 || effective.getInteger("guideScore") < guideEffective.getInteger("score")) {
                    effective.put("guideScore", formatScore(guideEffective.getString("score")));
                }

                JSONArray jsonArray1 = new JSONArray();
                jsonArray1.add(searchHit.getTitle());
                jsonArray1.add(searchHit.getZdz());
                jsonArray1.add(searchHit.getFbdate());
                jsonArray1.add(guideEffective.getString("process"));
                effective.getJSONArray("table").add(jsonArray1);
            } while (--guideIndex > 0 && --size > 0);
        }

        if (CollUtil.isNotEmpty(guideTitle)) {
//            addProcess(id, step++, "&nbsp;&nbsp;&nbsp; 指南推荐：");
            for (String title : guideTitle) {
                addProcess(id, step++, title, stringBuilder);
            }
        } else {
            addProcess(id, step++, "暂未找到相关临床指南推荐。", stringBuilder);
        }

        // 优势
//        long begin_advantage = System.currentTimeMillis();
//        JSONObject advantage = new JSONObject();
//        try {
//            advantage = this.advantage_sdy(drugName, disease);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (advantage.getString("score") == null) {
//                advantage.put("score", 0);
//            }
//            if (advantage.getString("process") == null) {
//                advantage.put("process", "");
//            }
//        }
//        log.info("advantage  gpt  分析时长{}", System.currentTimeMillis() - begin_advantage);
//
        JSONObject advantage = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("advantage"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("advantage").get();
                if (isSuccess) {
                    advantage = gptAnalysisMap_sdy.get("advantage");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        addProcess(id, step++, "（2）与同类药品相比有效性性优势：", stringBuilder);
        addProcess(id, step++, formatInfo(advantage.getString("process")), stringBuilder);
        effective.put("advantage", advantage.getString("process"));
        effective.put("advantageScore", formatScore(advantage.getString("score")));

        float effectiveScore = 0f;
        try {
            effectiveScore += effective.getFloat("guideScore");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            effectiveScore += advantage.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        effective.put("score", "有效性得分：" + formatNumber(effectiveScore) + "分");
        effective.put("vscore", formatNumber(effectiveScore));

        return step;
    }

    private int safetyAnalysis_sdy(String drugName, String disease, DrugInfoNew drugInfo, int step, String id, JSONObject result, Map<String, Future<Boolean>> futureResult_sdy, Map<String, JSONObject> gptAnalysisMap_sdy, DrugAddDto drugAdd, List<String> stringBuilder) {
        addProcess(id, step++, "<b>1、安全性</b>", stringBuilder);
        addProcess(id, step++, "主要从不良反应的严重程度及发生率（16分）、与同类药品相比安全性优势（4分）、特殊人群用药情况（10分）以及药物警戒情况（4分）四方面考察药品的安全性。", stringBuilder);

        // 1.1 严重不良反应
        long begin_adverseReaction = System.currentTimeMillis();
        JSONObject adverseReaction = new JSONObject();
        try {
            adverseReaction = this.adverseReaction_sdy(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (adverseReaction.getString("score") == null) {
                adverseReaction.put("score", 0);
            }
            if (adverseReaction.getString("process") == null) {
                adverseReaction.put("process", "");
            }
            if (StringUtils.isNotEmpty(drugInfo.getSeriousAdverseRactions())) {
                adverseReaction.put("process", drugInfo.getSeriousAdverseRactions());
            }

        }
        log.info("adverseReaction  gpt  分析时长{}", System.currentTimeMillis() - begin_adverseReaction);

        addProcess(id, step++, "（1）严重不良反应：", stringBuilder);
        addProcess(id, step++, formatInfo("严重不良反应：" + adverseReaction.getString("process")), stringBuilder);

        // 1.2 同类药物安全优势
        long begin_sameMedicineAdvantage = System.currentTimeMillis();
        JSONObject sameMedicineAdvantage = new JSONObject();
        try {
            sameMedicineAdvantage = this.sameMedicineAdvantage_sdy(drugName, disease, drugInfo);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (sameMedicineAdvantage.getString("score") == null) {
                sameMedicineAdvantage.put("score", 0);
            }
            if (StringUtils.isNotEmpty(drugInfo.getSafeAdvantage())) {
                sameMedicineAdvantage.put("process", drugInfo.getSafeAdvantage());
            }
        }
        log.info("sameMedicineAdvantage  gpt  分析时长{}", System.currentTimeMillis() - begin_sameMedicineAdvantage);

        addProcess(id, step++, "（2）与同类药品相比安全性优势：", stringBuilder);
        addProcess(id, step++, formatInfo(sameMedicineAdvantage.getString("process")), stringBuilder);

        // 1.3 特殊人群分析
        // 1.3.1 婴幼儿可用
        // 用来总结特殊人群 的所有proces
        StringBuilder specialCrowStrBuilder = new StringBuilder();

        long begin_specialCrowd_childrenMedicine_infant_sdy = System.currentTimeMillis();
        JSONObject specialCrowd_childrenMedicine_infant_sdy = new JSONObject();
        try {
            specialCrowd_childrenMedicine_infant_sdy = this.specialCrowd_childrenMedicine_infant_sdy(drugName, disease, drugInfo, drugAdd);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (specialCrowd_childrenMedicine_infant_sdy.getString("score") == null) {
                specialCrowd_childrenMedicine_infant_sdy.put("score", 0);
            }
            if (specialCrowd_childrenMedicine_infant_sdy.getString("process") == null) {
                specialCrowd_childrenMedicine_infant_sdy.put("process", "");
            }
        }
        log.info("specialCrowd_childrenMedicine_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_childrenMedicine_infant_sdy);

        addProcess(id, step++, "（3）特殊人群：", stringBuilder);
        addProcess(id, step++, formatInfo("婴幼儿:" + specialCrowd_childrenMedicine_infant_sdy.getString("process")), stringBuilder);
        specialCrowStrBuilder.append("婴幼儿:").append(specialCrowd_childrenMedicine_infant_sdy.getString("process"));

        // 1.3.2 儿童可用
        long begin_specialCrowd_childrenMedicine_sdy = System.currentTimeMillis();
        JSONObject specialCrowd_childrenMedicine_sdy = new JSONObject();
        try {
            specialCrowd_childrenMedicine_sdy = this.specialCrowd_childrenMedicine_sdy(drugName, disease, drugInfo, drugAdd);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (specialCrowd_childrenMedicine_sdy.getString("score") == null) {
                specialCrowd_childrenMedicine_sdy.put("score", 0);
            }
            if (specialCrowd_childrenMedicine_sdy.getString("process") == null) {
                specialCrowd_childrenMedicine_sdy.put("process", "");
            }
            if (StringUtils.isNotEmpty(drugInfo.getChildrenMedicine())) {
                String replace = drugInfo.getChildrenMedicine().replace("\\n$", "");
                specialCrowd_childrenMedicine_sdy.put("process", replace);
            }
        }
        log.info("specialCrowd_childrenMedicine_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_childrenMedicine_sdy);
        addProcess(id, step++, formatInfo("儿童:" + specialCrowd_childrenMedicine_sdy.getString("process")), stringBuilder);
        specialCrowStrBuilder.append("\n    儿童:").append(specialCrowd_childrenMedicine_sdy.getString("process"));


        // 1.3.3 孕妇可用或哺乳期妇女可用
//        long begin_specialCrowd_pregnantWomen_sdy = System.currentTimeMillis();
//        JSONObject specialCrowd_pregnantWomen_sdy = new JSONObject();
//        try {
//            specialCrowd_pregnantWomen_sdy = this.specialCrowd_pregnantWomen_sdy(drugName, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_pregnantWomen_sdy.getString("score") == null) {
//                specialCrowd_pregnantWomen_sdy.put("score", 0);
//            }
//            if (specialCrowd_pregnantWomen_sdy.getString("process") == null) {
//                specialCrowd_pregnantWomen_sdy.put("process", "");
//            }
//        }
//        log.info("specialCrowd_childrenMedicine_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_pregnantWomen_sdy);

        JSONObject specialCrowd_pregnantWomen_sdy = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("specialCrowd_pregnantWomen_sdy"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("specialCrowd_pregnantWomen_sdy").get();
                if (isSuccess) {
                    specialCrowd_pregnantWomen_sdy = gptAnalysisMap_sdy.get("specialCrowd_pregnantWomen_sdy");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_pregnantWomen_sdy.getString("score") == null) {
                    specialCrowd_pregnantWomen_sdy.put("score", 0);
                }
                if (specialCrowd_pregnantWomen_sdy.getString("process") == null) {
                    specialCrowd_pregnantWomen_sdy.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getPregnantWomen())) {
                    String replace = drugInfo.getPregnantWomen().replace("\\n$", "");
                    specialCrowd_pregnantWomen_sdy.put("process", replace);
                }
            }
        }
        addProcess(id, step++, formatInfo("孕妇或哺乳期妇女:" + specialCrowd_pregnantWomen_sdy.getString("process")), stringBuilder);
        specialCrowStrBuilder.append("\n    孕妇或哺乳期妇女:").append(specialCrowd_pregnantWomen_sdy.getString("process"));

        // 1.3.4 重度肝功能异常可用
//        long begin_specialCrowd_liver_sdy = System.currentTimeMillis();
//        JSONObject specialCrowd_liver_sdy = new JSONObject();
//        try {
//            specialCrowd_liver_sdy = this.specialCrowd_liver_sdy(drugName, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_liver_sdy.getString("score") == null) {
//                specialCrowd_liver_sdy.put("score", 0);
//            }
//            if (specialCrowd_liver_sdy.getString("process") == null) {
//                specialCrowd_liver_sdy.put("process", "");
//            }
//        }
//        log.info("specialCrowd_liver_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_liver_sdy);

        JSONObject specialCrowd_liver_sdy = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("specialCrowd_liver_sdy"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("specialCrowd_liver_sdy").get();
                if (isSuccess) {
                    specialCrowd_liver_sdy = gptAnalysisMap_sdy.get("specialCrowd_liver_sdy");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_liver_sdy.getString("score") == null) {
                    specialCrowd_liver_sdy.put("score", 0);
                }
                if (specialCrowd_liver_sdy.getString("process") == null) {
                    specialCrowd_liver_sdy.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    String replace = drugInfo.getDoseAdjustmentPatientsWithLiverDysfunction().replaceAll("\\n", "");
                    specialCrowd_liver_sdy.put("process", replace);
                }
            }
        }
        addProcess(id, step++, formatInfo("重度肝功能异常:" + specialCrowd_liver_sdy.getString("process")), stringBuilder);
        specialCrowStrBuilder.append("\n    重度肝功能异常:").append(specialCrowd_liver_sdy.getString("process"));


        // 1.3.4 重度肾功能异常可用
//        long begin_specialCrowd_kidney_sdy = System.currentTimeMillis();
//        JSONObject specialCrowd_kidney_sdy = new JSONObject();
//        try {
//            specialCrowd_kidney_sdy = this.specialCrowd_kidney_sdy(drugName, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (specialCrowd_kidney_sdy.getString("score") == null) {
//                specialCrowd_kidney_sdy.put("score", 0);
//            }
//            if (specialCrowd_kidney_sdy.getString("process") == null) {
//                specialCrowd_kidney_sdy.put("process", "");
//            }
//        }
//        log.info("specialCrowd_kidney_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_specialCrowd_kidney_sdy);

        JSONObject specialCrowd_kidney_sdy = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("specialCrowd_kidney_sdy"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("specialCrowd_kidney_sdy").get();
                if (isSuccess) {
                    specialCrowd_kidney_sdy = gptAnalysisMap_sdy.get("specialCrowd_kidney_sdy");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowd_kidney_sdy.getString("score") == null) {
                    specialCrowd_kidney_sdy.put("score", 0);
                }
                if (specialCrowd_kidney_sdy.getString("process") == null) {
                    specialCrowd_kidney_sdy.put("process", "");
                }
                if (StringUtils.isNotEmpty(drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                    String replace = drugInfo.getDoseAdjustmentPatientsWithRenalInsufficiency().replaceAll("\\n", "");
                    specialCrowd_kidney_sdy.put("process", replace);
                }
            }
        }
        addProcess(id, step++, formatInfo("重度肾功能异常:" + specialCrowd_kidney_sdy.getString("process")), stringBuilder);
        specialCrowStrBuilder.append("\n    重度肾功能异常:").append(specialCrowd_kidney_sdy.getString("process"));


        // 1.4 药物警戒
        long begin_pharmacovigilance_sdy = System.currentTimeMillis();
//        JSONObject pharmacovigilance_sdy = new JSONObject();
//        try {
//            pharmacovigilance_sdy = this.pharmacovigilance_sdy(drugName, drugInfo);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        } finally {
//            if (pharmacovigilance_sdy.getString("score") == null) {
//                pharmacovigilance_sdy.put("score", 0);
//            }
//            if (pharmacovigilance_sdy.getString("process") == null) {
//                pharmacovigilance_sdy.put("process", "暂无内容");
//            }
//        }
//        log.info("pharmacovigilance_sdy  gpt  分析时长{}", System.currentTimeMillis() - begin_pharmacovigilance_sdy);

        JSONObject pharmacovigilance_sdy = new JSONObject();
        if (Objects.nonNull(futureResult_sdy.get("pharmacovigilance_sdy"))) {
            try {
                Boolean isSuccess = futureResult_sdy.get("pharmacovigilance_sdy").get();
                if (isSuccess) {
                    pharmacovigilance_sdy = gptAnalysisMap_sdy.get("pharmacovigilance_sdy");
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        addProcess(id, step++, "（4）药物警戒相关信息", stringBuilder);
        // 五级中文
        String drugZh = drugInfo.getDrugZh();
        ArrayList<String> drugZhes = new ArrayList<>();
        drugZhes.add(drugZh);
        ArrayList<String> drugZhs = new ArrayList<>();
        for (String zh : drugZhes) {
            if (StringUtils.isNotEmpty(zh)) {
                String[] split = zh.split("\\/");
                for (String s : split) {
                    if (StringUtils.isNotEmpty(s)) {
                        drugZhs.add(s);
                    }
                }
            }
        }
        drugZhs.remove("");
        drugZhs.addAll(drugInfo.getDrugSynonymZh());
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
        StringBuilder stringBuilder1 = new StringBuilder();
        if (pharmacovigilance.size() > 0 || pharmacovigilanceAdd.size() > 0) {
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
                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")..."), stringBuilder);
                    }
                    stringBuilder1.append("原文链接：" + pharmacovigilance.get(i).getString("title_url") + "\n");
                }
            } else {
                for (int i = 0; i < pharmacovigilanceAdd.size(); i++) {
                    String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带
                    x++;
                    stringBuilder1.append(circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
                            "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")\n");
                    stringBuilder1.append("原文链接：" + pharmacovigilanceAdd.get(i).getString("title_url") + "\n");
                    if (i == 0) {
                        addProcess(id, step++, formatInfo(circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
                                "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")..."), stringBuilder);
                    }

                }
            }
            gptAnalysisMap_sdy.get("pharmacovigilance_sdy").put("process", stringBuilder1.toString());
            gptAnalysisMap_sdy.get("pharmacovigilance_sdy").put("score", 0);
        } else {
            addProcess(id, step++, "NMPA暂未收录此药品药物警戒相关信息", stringBuilder);
            gptAnalysisMap_sdy.get("pharmacovigilance_sdy").put("process", "NMPA暂未收录此药品药物警戒相关信息。");
            gptAnalysisMap_sdy.get("pharmacovigilance_sdy").put("score", 4);
        }


        float safetyScore = 0f;
        float adverseReactionScore = 0f;
        // 计算安全性总得分
        try {
            safetyScore += adverseReaction.getFloat("score");
            adverseReactionScore += adverseReaction.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        float sameMedicineAdvantageScore = 0f;
        try {
            safetyScore += sameMedicineAdvantage.getFloat("score");
            sameMedicineAdvantageScore += sameMedicineAdvantage.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        // 特殊人群
        float specialCrowdScore = 0f;
        try {
            safetyScore += specialCrowd_childrenMedicine_infant_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_childrenMedicine_infant_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            safetyScore += specialCrowd_childrenMedicine_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_childrenMedicine_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            safetyScore += specialCrowd_pregnantWomen_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_pregnantWomen_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            safetyScore += specialCrowd_liver_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_liver_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        try {
            safetyScore += specialCrowd_kidney_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_kidney_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        try {
            safetyScore += specialCrowd_kidney_sdy.getFloat("score");
            specialCrowdScore += specialCrowd_kidney_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        float pharmacovigilanceScore = 0f;
        try {
            safetyScore += pharmacovigilance_sdy.getFloat("score");
            pharmacovigilanceScore += pharmacovigilance_sdy.getFloat("score");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        JSONObject safety = new JSONObject();
        result.put("safety", safety);

        String reason = "";
        reason += adverseReaction.getString("process") + "</br>";
        reason += sameMedicineAdvantage.getString("reason") + "</br>";
        reason += specialCrowStrBuilder.toString() + "</br>";
        reason += pharmacovigilance_sdy.getString("process") + "</br>";

        safety.put("reason", reason);
        safety.put("score", "安全性得分：" + formatNumber(safetyScore) + "分");
        safety.put("vscore", formatNumber(safetyScore));
        safety.put("summarize", "总分34分，主要从不良反应的严重程度及发生率（16分）、与同类药品相比安全性优势（4分）、特殊人群用药情况（10分）以及药物警戒情况（4分）四方面考察药品的安全性。");

        safety.put("adverseReactionsScore", formatNumber(adverseReactionScore));
        safety.put("similarDrugsScore", formatNumber(sameMedicineAdvantageScore));
        safety.put("specialPopulationsScore", formatNumber(specialCrowdScore));
        safety.put("pharmacovigilanceScore", formatNumber(pharmacovigilanceScore));

        safety.put("details", new JSONObject());
        safety.getJSONObject("details").put("adverseReactions", adverseReaction.getString("process"));
        safety.getJSONObject("details").put("similarDrugs", sameMedicineAdvantage.getString("process"));
        safety.getJSONObject("details").put("specialPopulations", specialCrowStrBuilder.toString());
        safety.getJSONObject("details").put("childrenMedicineInfant", specialCrowd_childrenMedicine_infant_sdy.getString("process"));
        safety.getJSONObject("details").put("childrenMedicine", specialCrowd_childrenMedicine_sdy.getString("process"));
        safety.getJSONObject("details").put("pregnantWomen", specialCrowd_pregnantWomen_sdy.getString("process"));
        safety.getJSONObject("details").put("specialCrowdLiver", specialCrowd_liver_sdy.getString("process"));
        safety.getJSONObject("details").put("specialCrowdKidney", specialCrowd_kidney_sdy.getString("process"));
        safety.getJSONObject("details").put("pharmacovigilance", pharmacovigilance_sdy.getString("process"));

        return step;
    }

    /**
     * 原苏大一逻辑 更新文新一言 成功之后 该代码可删除
     */
    public JSONObject sdyPanel_bak(String drugInfo, String disease, String id, String priceId, List<String> stringBuilder) {
        JSONObject result = new JSONObject();
        int step = 0;

        String[] arr = drugInfo.split("-");
        String drugName = arr[0];
        String enterpirceName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];

        result.put("ts", System.currentTimeMillis());
        result.put("disease", disease);
        result.put("cache_key", drugInfo + "_" + disease);

        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
        if (!GetSynonymUtil.judgeChinese(drugInfo)) {
            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
        }
        EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName)), EvidenceMesh.class, synonymTable);
        JSONObject instruction;
        List<String> entryTerms = new ArrayList<>();
        if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
            entryTerms = evidenceMesh.getEntryTerms();
        }
        if (CollUtil.isNotEmpty(entryTerms)) {
            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").in(entryTerms).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
        } else {
            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
        }
        String content = "";
        try {
            if (instruction != null) {
                String pdf = instruction.getString("pdf_name");
                String html = pdf.substring(0, pdf.length() - 3) + "html";
                String htmlContent = HttpUtil.downloadString("https://image.evimed.com/instructions\nmpa_html/" + html, "utf-8");
                content = HtmlUtil.cleanHtmlTag(htmlContent);
                content = content.length() > 1000 ? content.substring(0, 1000) : content;
            }

        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpirceName)), DrugInfoNew.class);
        if (drugInfo1 == null) {
            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
        }
        long begin = System.currentTimeMillis();
        addProcess(id, step++, "<p class='text_title'>基于江苏省标准，对" + drugInfo + "药品在治疗" + disease + "疾病进行临床综合评价，在治疗" + disease + "时，药品临床综合评价结果如下：</p>", stringBuilder);
//        addProcess(id,step ++,"在治疗"+disease+"时，药品临床综合评价结果如下：");
        addProcess(id, step++, "<b>1、安全性</b>", stringBuilder);
        addProcess(id, step++, "主要从不良反应的严重程度及发生率（16分）、与同类药品相比安全性优势（4分）、特殊人群用药情况（10分）以及药物警戒情况（4分）四方面考察药品的安全性。", stringBuilder);

        JSONObject adverseReactionAnalysis = new JSONObject();
        JSONObject adrsJsonObject = new JSONObject();
        String adverseReaction = drugInfo1.getAdverseReaction();
        try {
            adverseReactionAnalysis = adverseReactionAnalysis(drugName, StrUtil.isNotBlank(adverseReaction) ? adverseReaction : null);
            StringBuilder stringBuilder1 = new StringBuilder();
            if (StrUtil.isNotBlank(adverseReactionAnalysis.getString("mildAdverseReaction"))) {
                stringBuilder1.append("中度不良反应为").append(adverseReactionAnalysis.getString("mildAdverseReaction"));
            }
            if (StrUtil.isNotBlank(adverseReactionAnalysis.getString("severeAdverseReaction"))) {
                stringBuilder1.append("重度不良反应为").append(adverseReactionAnalysis.getString("severeAdverseReaction"));
            }
            // 不良反应评分
            adrsJsonObject = adrs(drugInfo, stringBuilder1.toString());
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (adrsJsonObject.getString("score") == null) {
                adrsJsonObject.put("score", 16);
            }
            if (adrsJsonObject.getString("reason") == null) {
                adrsJsonObject.put("reason", "暂无内容");
            }
        }
        addProcess(id, step++, "（1）严重不良反应：", stringBuilder);
        addProcess(id, step++, "中度不良反应：" + adverseReactionAnalysis.getString("mildAdverseReaction"), stringBuilder);
        addProcess(id, step++, "重度不良反应：" + adverseReactionAnalysis.getString("severeAdverseReaction"), stringBuilder);

        JSONObject sameClassResJsonObject = new JSONObject();
        try {
            // 同类药物安全优势
            sameClassResJsonObject = sameClass(drugName, drugInfo1);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (sameClassResJsonObject.getString("score") == null) {
                sameClassResJsonObject.put("score", 0);
            }
            if (sameClassResJsonObject.getString("reason") == null) {
                sameClassResJsonObject.put("reason", "暂无内容");
            }
        }
        addProcess(id, step++, "（2）与同类药品相比安全性优势：", stringBuilder);
        addProcess(id, step++, formatInfo(sameClassResJsonObject.getString("reason")), stringBuilder);

        // 特殊人群分析 与打分
        JSONObject specialCrowdAnalysis = new JSONObject();
        try {
            specialCrowdAnalysis = specialCrowdAnalysis(drugName, null);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (specialCrowdAnalysis.getString("pregnantWomen") == null) {
                specialCrowdAnalysis.put("pregnantWomen", "暂无内容");
            }
            if (specialCrowdAnalysis.getString("childrenMedicine") == null) {
                specialCrowdAnalysis.put("childrenMedicine", "暂无内容");
            }
            if (specialCrowdAnalysis.getString("geriatricMedicine") == null) {
                specialCrowdAnalysis.put("geriatricMedicine", "暂无内容");
            }
            if (specialCrowdAnalysis.getString("liverKidney") == null) {
                specialCrowdAnalysis.put("liverKidney", "暂无内容");
            }
        }

        JSONObject specialCrowdResJsonObject = new JSONObject();
        try {
            // 特殊人群评分
            specialCrowdResJsonObject = specialCrowd(drugInfo, instruction != null ? content : "");
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {
            if (specialCrowdResJsonObject.getString("score") == null) {
                specialCrowdResJsonObject.put("score", 0);
            }
            if (specialCrowdResJsonObject.getString("reason") == null) {
                specialCrowdResJsonObject.put("reason", "暂无内容");
            }
        }
        addProcess(id, step++, "（3）特殊人群：", stringBuilder);
        String pregnantWomen = drugInfo1.getPregnantWomen();
        addProcess(id, step++, formatInfo("孕妇及哺乳期妇女:" + (StrUtil.isNotBlank(pregnantWomen) ? pregnantWomen : StrUtil.isNotBlank(specialCrowdAnalysis.getString("pregnantWomen")) ? specialCrowdAnalysis.getString("pregnantWomen") : "")), stringBuilder);
        String childrenMedicine = drugInfo1.getChildrenMedicine();
        addProcess(id, step++, formatInfo("儿童:" + (StrUtil.isNotBlank(childrenMedicine) ? childrenMedicine : StrUtil.isNotBlank(specialCrowdAnalysis.getString("childrenMedicine")) ? specialCrowdAnalysis.getString("childrenMedicine") : "")), stringBuilder);
        String geriatricMedicine = drugInfo1.getGeriatricMedicine();
        addProcess(id, step++, formatInfo("老年:" + (StrUtil.isNotBlank(geriatricMedicine) ? geriatricMedicine : StrUtil.isNotBlank(specialCrowdAnalysis.getString("geriatricMedicine")) ? specialCrowdAnalysis.getString("geriatricMedicine") : "")), stringBuilder);
        addProcess(id, step++, formatInfo("肝肾功能者:" + (StrUtil.isNotBlank(specialCrowdAnalysis.getString("liverKidney")) ? specialCrowdAnalysis.getString("liverKidney") : "")), stringBuilder);


        // 计算安全性总得分
        int safetyScore = adrsJsonObject.getInteger("score") + sameClassResJsonObject.getInteger("score") + specialCrowdResJsonObject.getInteger("score");

        // 第二部分 药品综合评价之安全性
        JSONObject safety = new JSONObject();
        result.put("safety", safety);

        String reason = "";
        reason += adrsJsonObject.getString("reason") + "</br>";
        reason += sameClassResJsonObject.getString("reason") + "</br>";
        reason += specialCrowdResJsonObject.getString("reason") + "</br>";

        safety.put("reason", reason);
        safety.put("score", "安全性得分：" + safetyScore + "分");
        safety.put("vscore", safetyScore);
        safety.put("summarize", "总分34分，主要从不良反应的严重程度及发生率（16分）、与同类药品相比安全性优势（4分）、特殊人群用药情况（10分）以及药物警戒情况（4分）四方面考察药品的安全性。");

        safety.put("similarDrugsScore", sameClassResJsonObject.getInteger("score"));
        safety.put("adverseReactionsScore", adrsJsonObject.getInteger("score"));
        safety.put("specialPopulationsScore", specialCrowdResJsonObject.getInteger("score"));
        safety.put("pharmacovigilanceScore", 0);

        safety.put("details", new JSONObject());
        safety.getJSONObject("details").put("similarDrugs", sameClassResJsonObject.getString("reason"));
        safety.getJSONObject("details").put("adverseReactions", adrsJsonObject.getString("reason"));
        safety.getJSONObject("details").put("specialPopulations", specialCrowdResJsonObject.getString("reason"));
        safety.getJSONObject("details").put("pharmacovigilance", "无");
        addProcess(id, step++, "（4）药物警戒相关信息", stringBuilder);
        addProcess(id, step++, "暂无内容", stringBuilder);


        addProcess(id, step++, "<b>2、有效性</b>", stringBuilder);
        addProcess(id, step++, "主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。", stringBuilder);

        // 第三部分 药品综合评价之有效性
        JSONObject effective = new JSONObject();
        result.put("effectiveness", effective);
        effective.put("table", new JSONArray());
        effective.put("summarize", "总分48分，主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。");
        addProcess(id, step++, "（1）证据推荐情况：", stringBuilder);

        List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
        List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

        GetSynonyms(drugName, drugs, disease, diseases);
        // 指南筛选
        List<GuideVO> guideVOList = queryGuideByDrugAndDisease(drugs, drugInfo1.getDrugZh(), diseases, disease);
        // 取时间较新的2条作为判断依据
        List<GuideVO> oldGuideVOList = new ArrayList<>();
        if (CollUtil.isNotEmpty(guideVOList)) {
            if (guideVOList.size() > 4) {
                guideVOList = guideVOList.subList(0, 4);
            }
            guideVOList.sort((o1, o2) -> (int) (o2.getDateTs() - o1.getDateTs()));
            if (guideVOList.size() > 2) {
                oldGuideVOList = guideVOList;
                guideVOList = guideVOList.subList(0, 2);
                int size = oldGuideVOList.size();
                oldGuideVOList = oldGuideVOList.subList(2, size);
            }
        }

        effective.getJSONArray("table").add(Arrays.asList("指南名称", "发布机构", "发布日期", "推荐等级", "相关内容"));
        effective.put("score", 0);
        effective.put("advantageScore", 0);
        effective.put("guideScore", 0);
        step = filterGuideListSu(guideVOList, oldGuideVOList, effective, drugName, disease, id, step, stringBuilder);

        if (effective.getInteger("guideScore") > 43) {
            effective.put("guideScore", 44);
        }
        if (effective.getInteger("advantageScore") > 3) {
            effective.put("advantageScore", 4);
        }
        int effectiveScore = effective.getInteger("guideScore") + effective.getInteger("advantageScore");
        effective.put("score", "有效性得分：" + effectiveScore + "分");
        effective.put("vscore", effectiveScore);
        addProcess(id, step++, "（2）与同类药品相比有效性性优势：", stringBuilder);
        addProcess(id, step++, formatInfo(effective.getString("advantage")), stringBuilder);


        // 第四部分 药品综合评价之适宜性
        addProcess(id, step++, "<b>3、适宜性</b>", stringBuilder);
        addProcess(id, step++, "主要从使用方法/依从性（4分）、贮藏条件（4分）、复方制剂的成分及配比是否规范（6分）以及皮试要求（4分）四方面考察药品的适宜性。", stringBuilder);
        JSONObject suitRes = new JSONObject();
        result.put("suitability", suitRes);

        int skinScore = 0;
        String skinTestSituation = "";
        if (drugInfo1 != null) {
            String skinTest = drugInfo1.getSkinTest();
            skinTestSituation = skinTest;
            if (skinTest.contains("不")) {
                skinScore = 4;
            }
        }

        JSONObject suitScore = this.sdySuitScore(drugName, content);

        int suitVScore = 0;
        for (Map.Entry<String, Object> entry : suitScore.entrySet()) {
            if (!entry.getKey().contains("得分理由") && !entry.getKey().contains("msg")) {
                if ("皮试要求".equals(entry.getKey())) {
                    suitVScore += skinScore;
                } else {
                    suitVScore += Integer.parseInt(entry.getValue().toString());
                }
            }
        }

        suitRes.put("score", "适宜性得分：" + suitVScore + "分");
        suitRes.put("vscore", suitVScore);
        suitRes.put("summarize", "总分18分，主要从使用方法/依从性（4分）、贮藏条件（4分）、复方制剂的成分及配比是否规范（6分）以及皮试要求（4分）四方面考察药品的适宜性。");
        suitRes.put("skinScore", skinScore);
        suitRes.put("usageMethodScore", suitScore.getString("使用方法"));
        suitRes.put("compositionRatio", suitScore.getString("复方成分"));
        suitRes.put("storageScore", suitScore.getString("贮藏条件"));
        // suitRes.put("skinScore",suitScore.getString("皮试要求"));

        suitRes.put("details", new JSONObject());
        suitRes.getJSONObject("details").put("skinTestSituation", skinTestSituation);
        suitRes.getJSONObject("details").put("usageMethod", suitScore.getString("使用方法msg"));
        suitRes.getJSONObject("details").put("proportioningSituation", suitScore.getString("复方成分msg"));
        suitRes.getJSONObject("details").put("storageConditions", suitScore.getString("贮藏条件msg"));
        // suitRes.getJSONObject("details").put("skinTestSituation",suitScore.getString("皮试要求msg"));

        addProcess(id, step++, "（1）使用方法/依从性：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getUsageAndDosage()) ? drugInfo1.getUsageAndDosage() : suitScore.getString("使用方法msg")), stringBuilder);
        addProcess(id, step++, "（2）贮藏条件：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getStorage()) ? drugInfo1.getStorage() : suitScore.getString("贮藏条件msg")), stringBuilder);
        addProcess(id, step++, "（3）复方制剂：", stringBuilder);
        addProcess(id, step++, formatInfo(StrUtil.isNotBlank(drugInfo1.getIngredient()) ? drugInfo1.getIngredient() : suitScore.getString("复方成分msg")), stringBuilder);
        addProcess(id, step++, "（4）皮试：", stringBuilder);
        // addProcess(id,step ++,formatInfo(suitScore.getString("皮试要求msg")));
        addProcess(id, step++, formatInfo(skinTestSituation), stringBuilder);


        // 第五部分 药品综合评价之可及性
        JSONObject access = new JSONObject();
        result.put("accessibility", access);
        access.put("summarize", "主要从国家基本药物收录情况以及国家医保目录收录情况两方面分析药品的可及性");

        // 支付限制
        access.put("paymentLimits", false);
        access.put("paymentLimit", "");
        if (drugInfo1 != null && StringUtils.isNotBlank(drugInfo1.getPaymentScope())) {
            access.put("paymentLimits", true);
            access.put("paymentLimit", drugInfo1.getPaymentScope());
        }
        access.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
        // 基本药物
        access.put("essentialMedicines", false);
        if (drugInfo1 != null && StrUtil.equals(drugInfo1.getEssentialMedicines(), "是")) {
            access.put("essentialMedicines", true);
        }
        // 有无△要求
        String essentialType = drugInfo1.getEssentialType();
        access.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
        // 医保情况
        if (drugInfo1 != null && StrUtil.isNotBlank(drugInfo1.getMedicalInsurance())) {
            access.put("reimbursement", "医保" + drugInfo1.getMedicalInsurance());
            access.put("reimbursementList", true);
        } else {
            access.put("reimbursement", "");
            access.put("reimbursementList", false);
        }
        // 是否列为国家集中采购药品
        boolean isConcentrate = true;
        String drugCollection = drugInfo1.getDrugCollection();
        if ("本品非集采药品。".equals(drugCollection)) {
            isConcentrate = false;
        }
        access.put("procurementOfDrugs", isConcentrate);


        // 第六部分 药品综合评价之经济性
        result.put("time", DateUtil.formatDateTime(new Date()));
        try {
            // addProcess(id,step++,"开始进行经济性评分");
            JSONObject economical = new JSONObject();
            result.put("economical", economical);
            List<DrugAndPrice> drugAndPriceList = this.mongoTemplate.find(new Query(Criteria.where("drugName").is(drugName.toLowerCase()).and("bidWinningPrice").ne("0")), DrugAndPrice.class);
            economical.put("summarize", "主要从同类药品经济性情况分析药品的经济性");
            economical.put("manufacturerList", new JSONArray());
            economical.put("similarDrugsList", new JSONArray());
            economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产企业", "中标价（元）", "价格中位值（元）", "价格四分位值（元）")));
            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产企业", "中标价（元）", "价格中位值（元）", "价格四分位值（元）")));
            List<Double> priceList = new ArrayList<>();
            Double midPrice = 0d;
            if (drugAndPriceList.size() > 7) {
                drugAndPriceList = drugAndPriceList.subList(0, 7);
            }
            for (DrugAndPrice drugAndPrice : drugAndPriceList) {
                if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                    if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
                        priceList.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
                    }
                }
            }

            Collections.sort(priceList);
            if (CollectionUtil.isNotEmpty(priceList)) {
                midPrice = priceList.get((priceList.size() + 1) / 2);
            }


            for (DrugAndPrice drugAndPrice : drugAndPriceList) {
                if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                    if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
                        priceList.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
                        economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getConversionRate(), "", drugAndPrice.getManufacturer(), new BigDecimal(drugAndPrice.getBidWinningPrice()).setScale(2, BigDecimal.ROUND_HALF_UP), new BigDecimal(midPrice).setScale(2, BigDecimal.ROUND_HALF_UP), "")));
                    }
                }
            }

            if (entryTerms != null && CollectionUtil.isNotEmpty(entryTerms)) {
                /*List<JSONObject> jsonObjects = this.mongoTemplate.find(new Query(Criteria.where("四级中文").in(one.getJSONArray("words")).and("五级中文").ne(drugName)), JSONObject.class, "drug_5_class");
                for (JSONObject jsonObject : jsonObjects) {
                    DrugAndPrice drugAndPrices = this.mongoTemplate.findOne(new Query(Criteria.where("drugName").is(jsonObject.getString("五级中文"))), DrugAndPrice.class);
                    if (drugAndPrices == null) {
                        continue;
                    }
                    economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList(drugAndPrices.getDrugName(), drugAndPrices.getSpecifications(), "", "", drugAndPrices.getManufacturer(), drugAndPrices.getBidWinningPrice(), "", "")));
                }*/
                // 其他同类药物推荐
                Query query1 = new Query(Criteria.where("word").in(entryTerms));
                query1.with(Sort.by(Sort.Direction.DESC, "codeLevel"));
                GradeAndDrugs gradeAndDrugs = mongoTemplate.findOne(query1, GradeAndDrugs.class);
                List<String> similarDrugs = new ArrayList<>();
                if (gradeAndDrugs != null) {
                    Integer codeLevel = gradeAndDrugs.getCodeLevel();
                    if (codeLevel == 4) {
                        List<String> word = gradeAndDrugs.getWord();
                        word.remove(drugName);
                        similarDrugs.addAll(word);
                    }
                }
                if (CollUtil.isNotEmpty(similarDrugs)) {
                    List<DrugAndPrice> list = mongoTemplate.find(new Query(Criteria.where("drugName").in(similarDrugs)), DrugAndPrice.class);
                    Set<DrugAndPrice> set = new HashSet<>(list);
                    List<Double> priceList2 = new ArrayList<>();
                    Double midPrice2 = 0d;
                    if (set.size() > 7) {
                        set = new HashSet<>(new ArrayList<>(set).subList(0, 7));
                    }
                    for (DrugAndPrice drugAndPrice : set) {
                        if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                            if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
                                priceList2.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
                            }
                        }
                    }
                    Collections.sort(priceList2);
                    if (CollectionUtil.isNotEmpty(priceList2)) {
                        midPrice2 = priceList2.get((priceList2.size() + 1) / 2);
                    }
                    for (DrugAndPrice drugAndPrice : set) {
                        if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
                            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getConversionRate(), "", drugAndPrice.getManufacturer(), drugAndPrice.getBidWinningPrice(), new BigDecimal(midPrice2).setScale(2, RoundingMode.HALF_UP), "")));
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }


        // 第一部分 总体概括
        try {
            JSONObject overallSummary = new JSONObject();
            overallSummary.put("targetDrug", drugName);
            Integer summaryVScore = 0;
            summaryVScore += result.getJSONObject("safety").getInteger("vscore");
            summaryVScore += result.getJSONObject("suitability").getInteger("vscore");
            summaryVScore += result.getJSONObject("effectiveness").getInteger("vscore");
            result.put("overallSummary", overallSummary);
            overallSummary.put("comprehensiveScore", formatScore(summaryVScore.toString()));
            overallSummary.put("dimensionDiagram", new JSONArray());
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("max", 34);
            jsonObject1.put("name", "安全性");
            jsonObject1.put("value", result.getJSONObject("safety").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
            JSONObject jsonObject2 = new JSONObject();
            jsonObject2.put("max", 48);
            jsonObject2.put("name", "有效性");
            jsonObject2.put("value", result.getJSONObject("effectiveness").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
            JSONObject jsonObject3 = new JSONObject();
            jsonObject3.put("max", 18);
            jsonObject3.put("name", "适宜性");
            jsonObject3.put("value", result.getJSONObject("suitability").getInteger("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
            JSONObject jsonObject4 = new JSONObject();
            jsonObject4.put("max", 10);
            jsonObject4.put("name", "可及性");
            jsonObject4.put("value", 0);
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
            JSONObject jsonObject5 = new JSONObject();
            jsonObject5.put("max", 10);
            jsonObject5.put("name", "经济性");
            jsonObject5.put("value", 0);
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
        String uuid = cn.hutool.core.lang.UUID.randomUUID(true).toString(true);
        result.put("id", uuid);
        result.put("_id", uuid);
        result.put("drugName", drugName);
        result.put("disease", disease);
        result.put("drugInfo", drugInfo);
        this.mongoTemplate.insert(result, "drug_analyze_data");
        addProcess(id, step, "-END-", stringBuilder);
        log.info("pc端 苏一大 执行总时长{}", System.currentTimeMillis() - begin);
        return result;
    }

    @Override
    public JSONObject sdyPanelApp(String drugInfo, String disease, String id, String priceId, String specifications, String isCustom, long userId) {
        Boolean isExist = this.redisTemplate.hasKey("gpt:" + id + ":" + 0);
        JSONObject result = new JSONObject();
        int step = 0;
        if (Objects.isNull(isExist) || !isExist) {
            String[] arr = drugInfo.split("-");
            String drugName = arr[0];
            String enterpirceName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];

            result.put("ts", System.currentTimeMillis());
            result.put("disease", disease);
            result.put("cache_key", drugInfo + "_" + disease);

            String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
            if (!GetSynonymUtil.judgeChinese(drugInfo)) {
                synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
            }
            EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName.toLowerCase())), EvidenceMesh.class, synonymTable);
            List<String> entryTerms = new ArrayList<>();
            if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
                entryTerms = evidenceMesh.getEntryTerms();
            }

            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpirceName)), DrugInfoNew.class);
            if (drugInfo1 == null) {
                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
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


                }
            }

            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
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

                }
            }

            List<String> stringBuilder = new ArrayList<>();
            addProcess(id, step++, "<p class='text_title'>基于苏大一标准(抗菌药物遴选)，对" + drugName + "治疗" + disease + "疾病进行临床综合评价：</p>", stringBuilder);

            List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
            List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

            GetSynonyms(drugName, drugs, disease, diseases);

            // 此处存储的key 与 value 的值在获取同义词接口出保存
            String redis_key = "synonym:" + userId;
            String synonym = RedisUtils.getStr(redis_key);
            if (StrUtil.isNotBlank(synonym)) {
                List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {
                });
                for (SynonymVo synonymVo : synonymVos) {
                    // 表明输入词有药
                    if (Integer.parseInt(synonymVo.getType()) == 1) {
                        // 要所有已勾选的同义词
                        drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
                        // 排除所有反勾选的同义词
                        drugs.removeAll(synonymVo.getExcludeSynonyms());
                    }

                    // 如果在研究疾病清单处自定义疾病  那么前一个页面中如果自定义了同义词就不再使用 否则需要使用自定义的同义词
                    if (Integer.parseInt(isCustom) == 0) {
                        if (Integer.parseInt(synonymVo.getType()) == 3) {
                            // 要所有已勾选的同义词
                            diseases = new ArrayList<>(CollUtil.union(diseases, synonymVo.getSynonyms()));
                            // 排除所有反勾选的同义词
                            diseases.removeAll(synonymVo.getExcludeSynonyms());
                        }
                    }
                }
            }


            long begin = System.currentTimeMillis();

            Map<String, Future<Boolean>> futureResult_sdy = new HashMap<>();
            Map<String, JSONObject> gptAnalysisMap_sdy = new HashMap<>();
            Map<GuideVO, JSONObject> guideEffectiveMap_sdy = new HashMap<>();
            Map<GuideVO, JSONObject> guideOldEffectiveMap_sdy = new HashMap<>();

            useThreadPoolExecutePrompt_sdy(drugName, disease, drugInfo1, futureResult_sdy, gptAnalysisMap_sdy, guideEffectiveMap_sdy, guideOldEffectiveMap_sdy, new DrugAddDto(), drugs, diseases);

            // 安全性模块
            step = safetyAnalysis_sdy(drugName, disease, drugInfo1, step, id, result, futureResult_sdy, gptAnalysisMap_sdy, new DrugAddDto(), stringBuilder);

            // 有效性
            step = effectiveAnalysis_sdy(drugName, disease, drugInfo1, step, id, result, futureResult_sdy, gptAnalysisMap_sdy, guideEffectiveMap_sdy, guideOldEffectiveMap_sdy, stringBuilder);

            // 适宜性
            step = suitabilityAnalysis_sdy(drugName, disease, drugInfo1, futureResult_sdy, gptAnalysisMap_sdy, step, id, result, stringBuilder);

            // 可及性
            step = accessibilityAnalysis_sdy(drugInfo1, step, result);

            // 经济性
            step = economicalAnalysis_sdy(drugName, drugInfo1, step, result, enterpirceName, entryTerms, stringBuilder);


            // 第一部分 总体概括
            try {
                JSONObject overallSummary = new JSONObject();
                overallSummary.put("targetDrug", drugName);
                Integer summaryVScore = 0;
                summaryVScore += result.getJSONObject("safety").getInteger("vscore");
                summaryVScore += result.getJSONObject("suitability").getInteger("vscore");
                summaryVScore += result.getJSONObject("effectiveness").getInteger("vscore");
                result.put("overallSummary", overallSummary);
                overallSummary.put("comprehensiveScore", formatScore(summaryVScore.toString()));
                overallSummary.put("dimensionDiagram", new JSONArray());
                JSONObject jsonObject1 = new JSONObject();
                jsonObject1.put("max", 34);
                jsonObject1.put("name", "安全性");
                jsonObject1.put("value", result.getJSONObject("safety").getInteger("vscore"));
                overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
                JSONObject jsonObject2 = new JSONObject();
                jsonObject2.put("max", 48);
                jsonObject2.put("name", "有效性");
                jsonObject2.put("value", result.getJSONObject("effectiveness").getInteger("vscore"));
                overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
                JSONObject jsonObject3 = new JSONObject();
                jsonObject3.put("max", 18);
                jsonObject3.put("name", "适宜性");
                jsonObject3.put("value", result.getJSONObject("suitability").getInteger("vscore"));
                overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
                JSONObject jsonObject4 = new JSONObject();
                jsonObject4.put("max", 10);
                jsonObject4.put("name", "可及性");
                jsonObject4.put("value", 0);
                overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
                JSONObject jsonObject5 = new JSONObject();
                jsonObject5.put("max", 10);
                jsonObject5.put("name", "经济性");
                jsonObject5.put("value", 0);
                overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
            String uuid = cn.hutool.core.lang.UUID.randomUUID(true).toString(true);
            result.put("id", uuid);
            result.put("_id", uuid);
            result.put("drugName", drugName);
            result.put("disease", disease);
            result.put("drugInfo", drugInfo);
            StringBuilder drugInfoSB = new StringBuilder();
            if (StrUtil.isNotBlank(drugName)) {
                drugInfoSB.append(drugName).append("-");
            }
            if (StrUtil.isNotBlank(specifications)) {
                drugInfoSB.append(specifications).append("-");
            }
            if (StrUtil.isNotBlank(enterpirceName)) {
                drugInfoSB.append(enterpirceName);
            }

            drugInfo = drugInfoSB.toString();
            result.put("drugInfo", drugInfo);
            this.mongoTemplate.insert(result, "drug_analyze_data");

            JSONObject variousScore = new JSONObject();
            evaluationService.calculateTotalScoreSdy(variousScore, result, drugName, disease);
            redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, variousScore, 1, TimeUnit.HOURS);

            this.mongoTemplate.save(result, "drug_analyze_data");
            addProcess(id, step, "-END-", stringBuilder);
            log.info("app端 苏一大 执行总时长{}", System.currentTimeMillis() - begin);
            result.put("content", stringBuilder);
        }
        return result;
    }

//    @Override
//    public JSONObject sdyPanelApp_bak(String drugInfo, String disease, String id, String priceId) {
//        String[] arr = drugInfo.split("-");
//        String drugName = arr[0];
//        String enterpirceName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];
//        JSONObject result = new JSONObject();
//        Query query = new Query(Criteria.where("cache_key").is(drugInfo + "_" + disease));
//        query.with(Sort.by(Sort.Direction.DESC, "ts"));
//        int step = 0;
//        result.put("ts", System.currentTimeMillis());
//        result.put("disease", disease);
//        result.put("cache_key", drugInfo + "_" + disease);
//
//        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
//        if (!GetSynonymUtil.judgeChinese(drugInfo)) {
//            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
//        }
//        EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName)), EvidenceMesh.class, synonymTable);
//        JSONObject instruction;
//        List<String> entryTerms = new ArrayList<>();
//        if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
//            entryTerms = evidenceMesh.getEntryTerms();
//        }
//        if (CollUtil.isNotEmpty(entryTerms)) {
//            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").in(entryTerms).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
//        } else {
//            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
//        }
//        String content = "";
//        try {
//            if (instruction != null) {
//                String pdf = instruction.getString("pdf_name");
//                String html = pdf.substring(0, pdf.length() - 3) + "html";
//                String htmlContent = HttpUtil.downloadString("https://image.evimed.com/instructions\nmpa_html/" + html, "utf-8");
//                content = HtmlUtil.cleanHtmlTag(htmlContent);
//                content = content.length() > 1000 ? content.substring(0, 1000) : content;
//            }
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//
//        JSONObject one = this.mongoTemplate.findOne(new Query(Criteria.where("words").is(drugName.toLowerCase())), JSONObject.class, "drug_name_words");
////        JSONObject instruction;
////        if(one != null && CollectionUtil.isNotEmpty(one.getJSONArray("words"))){
////            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").in(one.getJSONArray("words")).and("enterpriseName").is(enterpirceName)),JSONObject.class,"instructions");
////        }else {
////            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName).and("enterpriseName").is(enterpirceName)),JSONObject.class,"instructions");
////        }
////        String content = "";
////        if(instruction!=null) {
////            String pdf = instruction.getString("pdf_name");
////            String html = pdf.substring(0, pdf.length() - 3) + "html";
////            String htmlContent = "";
////            try {
////                htmlContent = HttpUtil.downloadString("https://image.evimed.com/instructions\nmpa_html/" + html, "utf-8");
////            } catch (Exception e) {
////                log.error(e.getMessage(), e);
////            }
////            content = HtmlUtil.cleanHtmlTag(htmlContent);
////            content = content.length() > 1000 ? content.substring(0,1000) : content;
////        }
//        long begin = System.currentTimeMillis();
//        //多线程提高速度
//        ExecutorService executorService = Executors.newFixedThreadPool(7);
//        String finalContent = content;
//        Runnable runnable1 = () -> {
//            JSONObject adrsJsonObject = new JSONObject();
//            try {
//                adrsJsonObject = adrs(drugName, finalContent);
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (adrsJsonObject.getString("score") == null) {
//                    adrsJsonObject.put("score", 0);
//                }
//                if (adrsJsonObject.getString("reason") == null) {
//                    adrsJsonObject.put("reason", "");
//                }
//            }
//
//            JSONObject sameClassResJsonObject = new JSONObject();
//            try {
//                sameClassResJsonObject = sameClass(drugName, new DrugInfo());
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (sameClassResJsonObject.getString("score") == null) {
//                    sameClassResJsonObject.put("score", 0);
//                }
//                if (sameClassResJsonObject.getString("reason") == null) {
//                    sameClassResJsonObject.put("reason", "");
//                }
//            }
//
//            JSONObject specialCrowdResJsonObject = new JSONObject();
//            try {
//                specialCrowdResJsonObject = specialCrowd(drugName, instruction != null ? finalContent : "");
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            } finally {
//                if (specialCrowdResJsonObject.getString("score") == null) {
//                    specialCrowdResJsonObject.put("score", 0);
//                }
//                if (specialCrowdResJsonObject.getString("reason") == null) {
//                    specialCrowdResJsonObject.put("reason", "");
//                }
//            }
//
//            int score = adrsJsonObject.getInteger("score") + sameClassResJsonObject.getInteger("score") + specialCrowdResJsonObject.getInteger("score");
//            JSONObject safety = new JSONObject();
//            String reason = "";
//            try {
//                reason += adrsJsonObject.getString("reason") + "</br>";
//            } catch (Exception ignored) {
//            }
//            try {
//                reason += sameClassResJsonObject.getString("reason") + "</br>";
//            } catch (Exception ignored) {
//            }
//            try {
//                reason += specialCrowdResJsonObject.getString("reason") + "</br>";
//            } catch (Exception ignored) {
//            }
//            safety.put("reason", reason);
//            safety.put("score", "安全性得分：" + score + "分");
//            safety.put("vscore", score);
//            safety.put("summarize", "总分34分，主要从不良反应的严重程度及发生率（16分）、与同类药品相比安全性优势（4分）、特殊人群用药情况（10分）以及药物警戒情况（4分）四方面考察药品的安全性。");
//            safety.put("details", new JSONObject());
//
//            safety.put("similarDrugsScore", sameClassResJsonObject.getInteger("score"));
//            safety.put("adverseReactionsScore", adrsJsonObject.getInteger("score"));
//            safety.put("specialPopulationsScore", specialCrowdResJsonObject.getInteger("score"));
//            safety.put("pharmacovigilanceScore", 0);
//            safety.getJSONObject("details").put("similarDrugs", sameClassResJsonObject.getString("reason"));
//            safety.getJSONObject("details").put("adverseReactions", adrsJsonObject.getString("reason"));
//            safety.getJSONObject("details").put("specialPopulations", specialCrowdResJsonObject.getString("reason"));
//            safety.getJSONObject("details").put("pharmacovigilance", "无");
//            result.put("safety", safety);
//        };
//
//        List<String> finalEntryTerms = entryTerms;
//        Runnable runnable2 = () -> {
//            JSONObject effective = new JSONObject();
//            result.put("effectiveness", effective);
//
//            //2.2 分析指南
//            List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
//            List<String> diseases = new ArrayList<>(Collections.singletonList(disease));
//
//            GetSynonyms(drugName, drugs, disease, diseases);
//            // 获取指南
//            List<GuideVO> guideVOList = queryGuideByDrugAndDisease(drugs, drugName, diseases, disease);
//            if (CollUtil.isNotEmpty(guideVOList)) {
//                if (guideVOList.size() > 3) {
//                    guideVOList = guideVOList.subList(0, 3);
//                }
//            }
//            effective.put("summarize", "总分48分，主要从证据推荐情况（44分）、与同类药品相比，临床治疗有特别优势（4分）两方面考察药品的有效性。");
//            effective.put("table", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
//            effective.put("vscore", 0);
//            effective.put("advantageScore", 0);
//            // 开始进行指南的分析
//            filterGuideListSuApp(guideVOList, effective, drugName, disease);
//            Integer score = effective.getInteger("vscore") + effective.getInteger("advantageScore");
//            effective.put("vscore", score);
//            effective.put("score", "有效性得分为：" + score + "分");
//        };
//
//        String finalContent1 = content;
//        Runnable runnable3 = () -> {
//            JSONObject suitRes = new JSONObject();
//            result.put("suitability", suitRes);
//            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpirceName)), DrugInfoNew.class);
//            if (drugInfo1 == null) {
//                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
//            }
//
//            int skinScore = 0;
//            String skinTestSituation = "";
//            if (drugInfo1 != null) {
//                String skinTest = drugInfo1.getSkinTest();
//                skinTestSituation = skinTest;
//                if (skinTest.contains("不")) {
//                    skinScore = 4;
//                }
//            }
//            JSONObject suitScore = this.sdySuitScore(drugName, finalContent1);
//            int vscore = 0;
//            for (Map.Entry<String, Object> entry : suitScore.entrySet()) {
//                if (!entry.getKey().contains("得分理由") && !entry.getKey().contains("msg")) {
//                    if ("皮试要求".equals(entry.getKey())) {
//                        vscore += skinScore;
//                    } else {
//                        vscore += Integer.parseInt(entry.getValue().toString());
//                    }
//                }
//            }
//            suitRes.put("score", "适宜性得分：" + vscore + "分");
//            suitRes.put("vscore", vscore);
//            suitRes.put("summarize", "总分18分，主要从使用方法/依从性（4分）、贮藏条件（4分）、复方制剂的成分及配比是否规范（6分）以及皮试要求（4分）四方面考察药品的适宜性。");
//            suitRes.put("details", new JSONObject());
//            //suitRes.put("skinScore", suitScore.getString("皮试要求"));
//            suitRes.put("skinScore", skinScore);
//            suitRes.put("usageMethodScore", suitScore.getString("使用方法"));
//            suitRes.put("compositionRatio", suitScore.getString("复方成分"));
//            suitRes.put("storageScore", suitScore.getString("贮藏条件"));
//            suitRes.getJSONObject("details").put("skinTestSituation", skinTestSituation);
//            suitRes.getJSONObject("details").put("usageMethod", suitScore.getString("使用方法msg"));
//            suitRes.getJSONObject("details").put("proportioningSituation", suitScore.getString("复方成分msg"));
//            suitRes.getJSONObject("details").put("storageConditions", suitScore.getString("贮藏条件msg"));
//            result.put("suitability", suitRes);
//        };
//
//        Runnable runnable4 = () -> {
//            JSONObject access = new JSONObject();
//            result.put("accessibility", access);
//            access.put("summarize", "主要从国家基本药物收录情况以及国家医保目录收录情况两方面分析药品的可及性");
//            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpirceName)), DrugInfoNew.class);
//            if (drugInfo1 == null) {
//                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
//            }
//            access.put("paymentLimits", false);
//            if (drugInfo1 != null && StringUtils.isNotBlank(drugInfo1.getPaymentScope())) {
//                access.put("paymentLimits", true);
//            }
//            access.put("essentialMedicines", false);
//            if (drugInfo1 != null && StrUtil.equals(drugInfo1.getEssentialMedicines(), "是")) {
//                access.put("essentialMedicines", true);
//            }
//            if (drugInfo1 != null && StrUtil.isNotBlank(drugInfo1.getMedicalInsurance())) {
//                access.put("reimbursement", drugInfo1.getMedicalInsurance());
//                access.put("reimbursementList", true);
//            } else {
//                access.put("reimbursement", "");
//                access.put("reimbursementList", false);
//            }
//        };
//
//        Runnable runnable5 = () -> {
//            JSONObject economical = new JSONObject();
//            result.put("economical", economical);
//            List<DrugAndPrice> drugAndPriceList = this.mongoTemplate.find(new Query(Criteria.where("drugName").is(drugName.toLowerCase()).and("bidWinningPrice").ne("0")), DrugAndPrice.class);
//            economical.put("summarize", "主要从同类药品经济性情况分析药品的经济性");
//            economical.put("manufacturerList", new JSONArray());
//            economical.put("similarDrugsList", new JSONArray());
//            economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产企业", "中标价（元）", "价格中位值（元）", "价格四分位值（元）")));
//            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList("药品名称", "药品规格", "转换比", "单位", "生产企业", "中标价（元）", "价格中位值（元）", "价格四分位值（元）")));
//            List<Double> priceList = new ArrayList<>();
//            Double midPrice = 0d;
//            if (drugAndPriceList.size() > 7) {
//                drugAndPriceList = drugAndPriceList.subList(0, 7);
//            }
//            for (DrugAndPrice drugAndPrice : drugAndPriceList) {
//                if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
//                    if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
//                        priceList.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
//                    }
//                }
//            }
//            Collections.sort(priceList);
//            if (CollectionUtil.isNotEmpty(priceList)) {
//                midPrice = priceList.get((priceList.size() + 1) / 2);
//            }
//            for (DrugAndPrice drugAndPrice : drugAndPriceList) {
//                if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
//                    if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
//                        priceList.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
//                        economical.getJSONArray("manufacturerList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getConversionRate(), "", drugAndPrice.getManufacturer(), new BigDecimal(drugAndPrice.getBidWinningPrice()).setScale(2, BigDecimal.ROUND_HALF_UP), new BigDecimal(midPrice).setScale(2, BigDecimal.ROUND_HALF_UP), "")));
//                    }
//                }
//            }
//
//            if (one != null && CollectionUtil.isNotEmpty(one.getJSONArray("words"))) {
//                //其他同类药物推荐
//                Query query1 = new Query(Criteria.where("word").in(one.getJSONArray("words")));
//                query1.with(Sort.by(Sort.Direction.DESC, "codeLevel"));
//                GradeAndDrugs gradeAndDrugs = mongoTemplate.findOne(query1, GradeAndDrugs.class);
//                List<String> similarDrugs = new ArrayList<>();
//                if (gradeAndDrugs != null) {
//                    Integer codeLevel = gradeAndDrugs.getCodeLevel();
//                    if (codeLevel == 4) {
//                        List<String> word = gradeAndDrugs.getWord();
//                        word.remove(drugName);
//                        similarDrugs.addAll(word);
//                    }
//                }
//                if (CollUtil.isNotEmpty(similarDrugs)) {
//                    List<DrugAndPrice> list = mongoTemplate.find(new Query(Criteria.where("drugName").in(similarDrugs)), DrugAndPrice.class);
//                    Set<DrugAndPrice> set = new HashSet<>(list);
//                    List<Double> priceList2 = new ArrayList<>();
//                    Double midPrice2 = 0d;
//                    if (set.size() > 7) {
//                        set = new HashSet<>(new ArrayList<>(set).subList(0, 7));
//                    }
//                    for (DrugAndPrice drugAndPrice : set) {
//                        if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
//                            if (StrUtil.isNotBlank(drugAndPrice.getBidWinningPrice())) {
//                                priceList2.add(Double.parseDouble(drugAndPrice.getBidWinningPrice()));
//                            }
//                        }
//                    }
//                    Collections.sort(priceList2);
//                    if (CollectionUtil.isNotEmpty(priceList2)) {
//                        midPrice2 = priceList2.get((priceList2.size() + 1) / 2);
//                    }
//                    for (DrugAndPrice drugAndPrice : set) {
//                        if (!enterpirceName.equalsIgnoreCase(drugAndPrice.getManufacturer())) {
//                            economical.getJSONArray("similarDrugsList").add(new ArrayList<>(Arrays.asList(drugAndPrice.getDrugName(), drugAndPrice.getSpecifications(), drugAndPrice.getConversionRate(), "", drugAndPrice.getManufacturer(), drugAndPrice.getBidWinningPrice(), new BigDecimal(midPrice2).setScale(2, BigDecimal.ROUND_HALF_UP), "")));
//                        }
//                    }
//                }
//            }
//        };
//        executorService.execute(runnable1);
//        executorService.execute(runnable2);
//        executorService.execute(runnable3);
//        executorService.execute(runnable4);
//        executorService.execute(runnable5);
//        executorService.shutdown();
//        while (!executorService.isTerminated()) {
//            try {
//                Thread.sleep(1);
//            } catch (InterruptedException e) {
//                log.error(e.getMessage(), e);
//            }
//        }
//
//        try {
//            JSONObject overallSummary = new JSONObject();
//            overallSummary.put("targetDrug", drugName);
//            Integer vscore = 0;
//            vscore += result.getJSONObject("safety").getInteger("vscore");
//            vscore += result.getJSONObject("suitability").getInteger("vscore");
//            vscore += result.getJSONObject("effectiveness").getInteger("vscore");
//            result.put("overallSummary", overallSummary);
//            overallSummary.put("comprehensiveScore", vscore);
//            overallSummary.put("dimensionDiagram", new JSONArray());
//            JSONObject jsonObject1 = new JSONObject();
//            jsonObject1.put("max", 34);
//            jsonObject1.put("name", "安全性");
//            jsonObject1.put("value", result.getJSONObject("safety").getInteger("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject1);
//            JSONObject jsonObject2 = new JSONObject();
//            jsonObject2.put("max", 48);
//            jsonObject2.put("name", "有效性");
//            jsonObject2.put("value", result.getJSONObject("effectiveness").getInteger("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject2);
//            JSONObject jsonObject3 = new JSONObject();
//            jsonObject3.put("max", 18);
//            jsonObject3.put("name", "适宜性");
//            jsonObject3.put("value", result.getJSONObject("suitability").getInteger("vscore"));
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject3);
//            JSONObject jsonObject4 = new JSONObject();
//            jsonObject4.put("max", 10);
//            jsonObject4.put("name", "可及性");
//            jsonObject4.put("value", 0);
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject4);
//            JSONObject jsonObject5 = new JSONObject();
//            jsonObject5.put("max", 10);
//            jsonObject5.put("name", "经济性");
//            jsonObject5.put("value", 0);
//            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//        }
//        result.put("time", DateUtil.formatDateTime(new Date()));
//        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
//        String uuid = cn.hutool.core.lang.UUID.randomUUID(true).toString(true);
//        result.put("id", uuid);
//        result.put("_id", uuid);
//        result.put("drugName", drugName);
//        result.put("disease", disease);
//        result.put("drugInfo", drugInfo);
//        this.mongoTemplate.insert(result, "drug_analyze_data");
//        addProcess(id, ++step, "-END-");
//        log.info("app端 苏一大执行总时长{}", System.currentTimeMillis() - begin);
//        return result;
//    }

    /**
     * 指南检索 APP  存留的上一版本
     */
    @Override
    public JSONObject guidePanelApp_bak(String drugInfo, String disease, String id, String priceId) {
        String[] arr = drugInfo.split("-");
        String drugName = arr[0];
        String enterpirceName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];
        JSONObject result = new JSONObject();
        result.put("disease", disease);
        Query query = new Query(Criteria.where("cache_key").is(drugInfo + "_" + disease));
        query.with(Sort.by(Sort.Direction.DESC, "ts"));
        result.put("ts", System.currentTimeMillis());
        result.put("cache_key", drugInfo + "_" + disease);

        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
        if (!GetSynonymUtil.judgeChinese(drugInfo)) {
            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
        }
        EvidenceMesh evidenceMesh = mongoTemplate.findOne(new Query(Criteria.where("entryTerms").is(drugName)), EvidenceMesh.class, synonymTable);
//        JSONObject drugNameWords = this.mongoTemplate.findOne(new Query(Criteria.where("words").is(drugName.toLowerCase())), JSONObject.class, "drug_name_words");
        JSONObject instruction;
        List<String> entryTerms = new ArrayList<>();
        if (Objects.nonNull(evidenceMesh) && CollUtil.isNotEmpty(evidenceMesh.getEntryTerms())) {
            entryTerms = evidenceMesh.getEntryTerms();
        }
//        JSONObject drugNameWords = this.mongoTemplate.findOne(new Query(Criteria.where("words").is(drugName.toLowerCase())), JSONObject.class, "drug_name_words");
//        JSONObject instruction;
        if (CollUtil.isNotEmpty(entryTerms)) {
            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").in(entryTerms).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
        } else {
            instruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName).and("enterpriseName").is(enterpirceName)), JSONObject.class, "instructions");
        }
        final String[] content = {""};
        if (instruction != null) {
            String pdf = instruction.getString("pdf_name");
            String html = pdf.substring(0, pdf.length() - 3) + "html";
            String htmlContent = "";
            try {
                htmlContent = HttpUtil.downloadString("https://image.evimed.com/instructions\nmpa_html/" + html, "utf-8");
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            content[0] = HtmlUtil.cleanHtmlTag(htmlContent);
        }

        long begin = System.currentTimeMillis();
        CountDownLatch countDownLatch = new CountDownLatch(5);
        threadPoolTaskExecutor.execute(() -> {
            JSONObject pharmaceuticalCharacteristics = new JSONObject();
            result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
            pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
            pharmaceuticalCharacteristics.put("table", new JSONArray().fluentAdd(new ArrayList<>(Arrays.asList("序号", "评价条目", "相关内容", "得分"))));
            pharmaceuticalCharacteristics.put("vscore", 0);

//            JSONObject intruction = this.mongoTemplate.findOne(new Query(Criteria.where("simpleGenericNames").is(drugName)),JSONObject.class,"instructions");
//            if(intruction != null){
            Float score = 0f;
            content[0] = content[0].length() > 1000 ? content[0].substring(0, 1000) : content[0];
            // GPT3.5
            JSONObject pharmacy = new JSONObject();
            try {
                pharmacy = this.pharmacy(drugName, disease, content[0]);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (pharmacy.getString("pharmacology") == null) {
                    pharmacy.put("pharmacology", "");
                }
                if (pharmacy.getString("disposition") == null) {
                    pharmacy.put("disposition", "");
                }
                if (pharmacy.getString("storage") == null) {
                    pharmacy.put("storage", "");
                }
                if (pharmacy.getString("pharmaceutics") == null) {
                    pharmacy.put("pharmaceutics", "");
                }
                if (pharmacy.getString("usage") == null) {
                    pharmacy.put("usage", "");
                }
                if (pharmacy.getString("period") == null) {
                    pharmacy.put("period", "");
                }
            }

            JSONObject pharmacyScore = new JSONObject();
            try {
                pharmacyScore = this.pharmacyScore(drugName, null, pharmacy);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            try {
                pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("1", "药理作用", pharmacy.getString("pharmacology"), pharmacyScore.getString("药理作用").contains("分数") ? pharmacyScore.getJSONObject("药理作用").getString("分数") : pharmacyScore.getString("药理作用"))));
                pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("2", "体内过程", pharmacy.getString("disposition"), pharmacyScore.getString("体内过程").contains("分数") ? pharmacyScore.getJSONObject("体内过程").getString("分数") : pharmacyScore.getString("体内过程"))));
                pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("3", "药剂学与使用方法", pharmacy.getString("pharmaceutics") + "</br>" + pharmacy.getString("usage"), pharmacyScore.getString("药剂学和使用方法").contains("分数") ? pharmacyScore.getJSONObject("药剂学和使用方法").getString("分数") : pharmacyScore.getString("药剂学和使用方法"))));
                pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("4", "贮藏条件", pharmacy.getString("storage"), pharmacyScore.getString("贮藏条件").contains("分数") ? pharmacyScore.getJSONObject("贮藏条件").getString("分数") : pharmacyScore.getString("贮藏条件"))));
                pharmaceuticalCharacteristics.getJSONArray("table").add(new ArrayList<>(Arrays.asList("5", "有效期", pharmacy.getString("period"), pharmacyScore.getString("药品有效期").contains("分数") ? pharmacyScore.getJSONObject("药品有效期").getString("分数") : pharmacyScore.getString("药品有效期"))));
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            // 计算药学特性部分总得分
            for (Map.Entry<String, Object> entry : pharmacyScore.entrySet()) {
                if (entry.getValue() != null) {
                    try {
                        String key = entry.getKey();
                        if (GetSynonymUtil.judgeChinese(key)) {
                            score += Float.parseFloat(entry.getValue().toString());
                        }
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                        try {
                            JSONObject jsonObject = JSONObject.parseObject(JSONObject.toJSONString(entry.getValue()));
                            score += jsonObject.getFloat("分数");
                        } catch (Exception ex) {
                            log.error(ex.getMessage(), ex);
                        }
                    }
                }
            }
            String pharmacyFormatScore = formatScore(new BigDecimal(score).setScale(2, RoundingMode.HALF_UP).toString());
            pharmaceuticalCharacteristics.put("score", "药学特性得分：" + pharmacyFormatScore + "分");
            pharmaceuticalCharacteristics.put("vscore", pharmacyFormatScore);
//            }
            countDownLatch.countDown();
        });

        List<String> finalEntryTerms = entryTerms;
        threadPoolTaskExecutor.execute(() -> {
            JSONObject effective = new JSONObject();
            result.put("effectiveness", effective);
            effective.put("effectiveness", "");

            // 2.1 适应症评分
            JSONObject indicationEffective = new JSONObject();
            try {
                indicationEffective = indicationEeffective(drugName, disease, null);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (indicationEffective.getString("score") == null) {
                    indicationEffective.put("score", 0);
                }
                if (indicationEffective.getString("process") == null) {
                    indicationEffective.put("process", "");
                }
            }
            effective.put("indication", indicationEffective.getString("process"));
            effective.put("indicationScore", indicationEffective.getInteger("score"));

            // 2.2 分析指南
            List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
            List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

            GetSynonyms(drugName, drugs, disease, diseases);
            // 获取指南
            List<GuideVO> guideVOList = queryGuideByDrugAndDisease(drugs, drugInfo, diseases, disease);
            // 取时间较新的2条作为判断依据
            List<GuideVO> oldGuideVOList = new ArrayList<>();
            if (CollUtil.isNotEmpty(guideVOList)) {
                if (guideVOList.size() > 4) {
                    guideVOList = guideVOList.subList(0, 4);
                }
                guideVOList.sort((o1, o2) -> (int) (o2.getDateTs() - o1.getDateTs()));
                if (guideVOList.size() > 2) {
                    guideVOList = guideVOList.subList(0, 2);
                    oldGuideVOList = guideVOList;
                    int size = oldGuideVOList.size();
                    oldGuideVOList = oldGuideVOList.subList(2, size);
                }
            }
//            effective.put("table", new JSONArray().fluentAdd(Arrays.asList("指南名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
            effective.put("guide", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "推荐等级", "相关内容")));
            effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
            effective.put("guideScore", 0);
            effective.put("literatureScore", 0);

            // 开始进行指南的分析
            filterGuideListApp(guideVOList, oldGuideVOList, effective, drugName, disease, id);

//            //文献筛选
//            List<Literature> literatureList = queryLiterature(drugName, drugs, disease, diseases, finalEntryTerms);
//            log.info("文献筛选出来几篇了呢{}",literatureList.size());
//            if (literatureList.size() >= Integer.valueOf("3")) {
//                literatureList = literatureList.subList(0, 3);
//            }
//            effective.put("literature", new JSONArray().fluentAdd(Arrays.asList("名称", "发布机构", "发布日期", "相关内容")));
//            int aNull1 = filterLiteratureList(literatureList, effective, drugName, disease, id, -1);

            // 2.3 临床疗效评分
            // GPT3.5
            JSONObject clinicalEffective = new JSONObject();
            try {
                clinicalEffective = clinicalEffect(drugName, disease);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (clinicalEffective.getString("score") == null) {
                    clinicalEffective.put("score", 0);
                }
                if (clinicalEffective.getString("process") == null) {
                    clinicalEffective.put("process", "");
                }
            }
            Integer effectiveVscore = indicationEffective.getInteger("score") + clinicalEffective.getInteger("score");
            // 记录总得分
            effective.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其有效性进行评价：总分27分，主要从适应证（5分）、指南推荐（12分）、临床疗效（10分）三方面考察药品的有效性。");
            effective.put("effectiveness", clinicalEffective.getString("process"));
            effective.put("effectivenessScore", clinicalEffective.getInteger("score"));
//            String effectiveFormatSorce = formatScore(new BigDecimal(effectiveVscore + effective.getFloat("guideScore") + effective.getFloat("literatureScore")).setScale(2, BigDecimal.ROUND_HALF_UP).toString());
            String effectiveFormatSorce = formatScore(new BigDecimal(effectiveVscore + effective.getFloat("guideScore")).setScale(2, RoundingMode.HALF_UP).toString());
            effective.put("vscore", effectiveFormatSorce);
            effective.put("score", "有效性得分：" + effectiveFormatSorce + "分");
            countDownLatch.countDown();
        });

        threadPoolTaskExecutor.execute(() -> {
            JSONObject safety = new JSONObject();
            result.put("safety", safety);
            // GOPT3.5
            JSONObject adrsJsonObject = new JSONObject();
            try {
                // GPT3.5
                // 指南不良反应评分
                adrsJsonObject = guideAdrsScore(drugName);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }

            float vScore = 0f;
            for (Map.Entry<String, Object> entry : adrsJsonObject.entrySet()) {
                try {
                    vScore += Float.parseFloat(entry.getValue().toString());
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }

            String reason = "";
            try {
                reason += adrsJsonObject.getString("reason") + "</br>";
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            safety.put("reason", reason);
            String formatSorce = formatScore(new BigDecimal(vScore).setScale(2, RoundingMode.HALF_UP).toString());
            safety.put("score", "安全性得分：" + formatSorce + "分");
            safety.put("vscore", formatSorce);
            safety.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其安全性进行评价：总分25分，主要从CTCAE-V5.0分级（8分）、特殊人群（11分）、药物相互作用（3分）和其他（3分）共四个方面进行考察药品的安全性。");
            safety.put("details", new JSONObject());

            safety.put("similarDrugsScore", "");
            safety.put("adverseReactionsScore", adrsJsonObject.getString("score"));
            safety.put("specialPopulationsScore", "");
            safety.put("pharmacovigilanceScore", "");

            JSONObject adrsInfoObject = new JSONObject();
            try {
                adrsInfoObject = guideAdrsInfo_v2(drugName, content[0]);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
            safety.put("table", new JSONArray());
            safety.getJSONArray("table").add(Arrays.asList("序号", "评价条目", "相关内容", "得分"));
            safety.getJSONArray("table").add(Arrays.asList("1", "中度不良反应", adrsInfoObject.getString("中度不良反应"), adrsJsonObject.getString("中度不良反应")));
            safety.getJSONArray("table").add(Arrays.asList("2", "重度不良反应", adrsInfoObject.getString("重度不良反应"), adrsJsonObject.getString("重度不良反应")));
            safety.getJSONArray("table").add(Arrays.asList("3", "特殊人群", adrsInfoObject.getString("特殊人群"), adrsJsonObject.getString("特殊人群")));
            safety.getJSONArray("table").add(Arrays.asList("4", "相互作用", adrsInfoObject.getString("相互作用"), adrsJsonObject.getString("药物相互作用")));
            safety.getJSONArray("table").add(Arrays.asList("5", "其他不良反应", adrsInfoObject.getString("其他不良反应"), adrsJsonObject.getString("其他不良反应")));
            countDownLatch.countDown();
        });

        threadPoolTaskExecutor.execute(() -> {
            JSONObject economical = new JSONObject();
            result.put("economical", economical);
            // 当前药品价格信息
            SaveDrugPrice currDrugFee = this.mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId).and("drugName").is(drugName).and("manufacturer").is(enterpirceName)), SaveDrugPrice.class);
            BigDecimal vScore = new BigDecimal(0);
            economical.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其经济性进行评价：总分10分，考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。");
            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getMinAverageDailyCost() != null) {
                try {
                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 3, RoundingMode.HALF_UP).multiply(new BigDecimal(3)).setScale(2, BigDecimal.ROUND_HALF_UP);
                    if (score.floatValue() > 3) {
                        score = BigDecimal.valueOf(3);
                    }
                    vScore = vScore.add(score);
                    economical.put("sameGericName", "评价方法：日均治疗费用最低的药品为" + score + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x3。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                vScore = vScore.add(new BigDecimal(3));
                economical.put("sameGericName", "待评价药品无同通用名药品，得3分。");
            }

            if (currDrugFee != null && currDrugFee.getAverageDailyCost() != null && currDrugFee.getAlternativeMinAverageDailyCost() != null) {
                try {
                    BigDecimal score = BigDecimal.valueOf(currDrugFee.getAlternativeMinAverageDailyCost()).divide(BigDecimal.valueOf(currDrugFee.getAverageDailyCost()), 2, RoundingMode.HALF_UP).multiply(new BigDecimal(7)).setScale(2, BigDecimal.ROUND_HALF_UP);
                    if (score.floatValue() > 7) {
                        score = BigDecimal.valueOf(7);
                    }
                    vScore = vScore.add(score);
                    economical.put("indicationReplace", "评价方法：日均治疗费用最低的药品为" + score + " 分，评价药品评分=最低日均治疗费用/评价药品日均治疗费用x7。根据您提供的药品日均治疗费用信息进行经计算，该项最终评分为" + score + "分。");
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                vScore = vScore.add(new BigDecimal(0));
                economical.put("indicationReplace", "待评价药品无主要适应证可替代药品，得0分。");
            }

            vScore = vScore.setScale(2, RoundingMode.HALF_UP);
            String formatScore = formatScore(vScore.toString());
            economical.put("score", "经济性得分：" + formatScore + "分");
            economical.put("vscore", formatScore);
            countDownLatch.countDown();
        });

        threadPoolTaskExecutor.execute(() -> {
            // 其他属性总得分
            float otherVscore;
            // 5.1 国家医保纳入情况模块
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpirceName)), DrugInfoNew.class);
            if (drugInfo1 == null) {
                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
            }
            // 是否在医保目录
            // boolean isInsurance = this.mongoTemplate.exists(new Query(Criteria.where("registered_name").is(drugName).and("medicine_enterprise").is(enterpirceName)),JSONObject.class,"medical_insurance_drugs");
            boolean isInsurance = false;
            assert drugInfo1 != null;
            String medicalInsurance = drugInfo1.getMedicalInsurance();
            if (StringUtils.isNotBlank(medicalInsurance)) {
                isInsurance = true;
            }

            // 医保得分
            float isInsuranceScore = 1.00F;
            if (isInsurance) {
                boolean paymentScopeStatus = StringUtils.isNotBlank(drugInfo1.getPaymentScope());
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
            otherVscore = isInsuranceScore;

            // 5.2 国家集中采购情况模块
            // 是否集中采购
            // boolean isConcentrate = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("enterprise").is(enterpirceName)),JSONObject.class,"country_concentrate_drugs");
            boolean isConcentrate = true;
            String drugCollection = drugInfo1.getDrugCollection();
            if ("本品非集采药品。".equals(drugCollection)) {
                isConcentrate = false;
            }
            otherVscore = isConcentrate ? otherVscore + 1 : otherVscore;

            // 5.3 国家基本药物目录纳入情况模块
            // 是否基本药物
            // boolean isBase = this.mongoTemplate.exists(new Query(Criteria.where("drugName").is(drugName).and("essentialMedicines").is("是")),DrugAndPrice.class);
            boolean isBase = false;
            String essentialMedicines = drugInfo1.getEssentialMedicines();
            if ("是".equals(essentialMedicines)) {
                isBase = true;
            }
            int typeScore = 0;
            String essentialType = drugInfo1.getEssentialType();
            if (StringUtils.isNotBlank(essentialType)) {
                typeScore = 1;
            }
            otherVscore = isBase ? otherVscore + 3 - typeScore : otherVscore + 1;

            // 5.4  药品情况模块
            // 药品情况的分析过程
            String drugSituationString = "未知";
            // 药品情况 GPT3.5
            JSONObject guideDrugSituation = new JSONObject();
            try {
                guideDrugSituation = guideDrugSituation(drugName, enterpirceName, drugInfo1);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideDrugSituation.getString("score") == null) {
                    guideDrugSituation.put("score", 0);
                }
                if (guideDrugSituation.getString("process") == null) {
                    guideDrugSituation.put("process", "");
                }
            }
            if (guideDrugSituation != null) {
                otherVscore = otherVscore + guideDrugSituation.getFloat("score");
                String info = guideDrugSituation.getString("info");
                if (StringUtils.isNotBlank(info)) {
                    drugSituationString = info;
                }
            }

            // 5.5 生产企业情况模块
            //
            String enterpriseString = "未知";
            // 生产企业情况
            JSONObject guideEnterprise = new JSONObject();
            try {
                guideEnterprise = guideEnterprise(enterpirceName, drugInfo1);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideEnterprise.getString("score") == null) {
                    guideEnterprise.put("score", 0);
                }
                if (guideEnterprise.getString("process") == null) {
                    guideEnterprise.put("process", "");
                }
                if (guideEnterprise.getString("info") == null) {
                    guideEnterprise.put("info", "");
                }
            }

            if (guideEnterprise != null) {
                otherVscore = otherVscore + guideEnterprise.getFloat("score");
                String info = guideEnterprise.getString("info");
                if (StringUtils.isNotBlank(info)) {
                    enterpriseString = info;
                }
            }

            // 5.6 全球使用情况模块
            // 全球使用情况
            String countryString = "未知";
            // GPT3.5
            JSONObject guideCountry = new JSONObject();
            try {
                guideCountry = guideCountry(drugName, drugInfo1);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
                ;
            } finally {
                if (guideCountry.getString("score") == null) {
                    guideCountry.put("score", 0);
                }
                if (guideCountry.getString("process") == null) {
                    guideCountry.put("process", "");
                }
                if (guideCountry.getString("info1") == null) {
                    guideCountry.put("info1", "");
                }
                if (guideCountry.getString("info2") == null) {
                    guideCountry.put("info2", "");
                }
            }

            if (guideCountry != null) {
                otherVscore = otherVscore + guideCountry.getFloat("score");
                String info = guideCountry.getString("info");
                if (StringUtils.isNotBlank(info)) {
                    countryString = info;
                }
            }


            JSONObject otherAttributes = new JSONObject();
            result.put("otherAttributes", otherAttributes);
            String formatScore = formatScore(new BigDecimal(otherVscore).setScale(2, BigDecimal.ROUND_HALF_UP).toString());
            otherAttributes.put("score", "其他属性得分：" + formatScore + "分");
            otherAttributes.put("vscore", formatScore);
            otherAttributes.put("paymentLimits", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
            otherAttributes.put("essentialMedicines", isBase);
            otherAttributes.put("reimbursementList", isInsurance);
            otherAttributes.put("reimbursement", StringUtils.isNotBlank(drugInfo1.getMedicalInsurance()) ? drugInfo1.getMedicalInsurance() + "类" : "");
            // 支付限制
            otherAttributes.put("paymentScopeStatus", StringUtils.isNotBlank(drugInfo1.getPaymentScope()) ? drugInfo1.getPaymentScope() : "");
            otherAttributes.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，对其他属性进行评价：总分10分，考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）。");
            // 是否列为国家集中采购药品
            otherAttributes.put("procurementOfDrugs", isConcentrate);
            // 国家基本药物得分
            otherAttributes.put("essentialMedicinesScore", isBase ? 3 - typeScore : 1);
            // 有无△要求
            otherAttributes.put("essentialType", StringUtils.isNotBlank(essentialType) ? essentialType : "");
            // 国家医保目录得分
            otherAttributes.put("reimbursementListScore", formatScore(String.valueOf(isInsuranceScore)));
            // 国家集中采购药品得分
            otherAttributes.put("procurementOfDrugsScore", isConcentrate ? 1 : 0);
            // 原研/参比/一致性评价
            otherAttributes.put("guideDrugSituationScore", formatScore(String.valueOf(guideDrugSituation.getFloat("score"))));
            // 生产企业状态
            otherAttributes.put("guideEnterpriseScore", formatScore(String.valueOf(guideEnterprise.getFloat("score"))));
            // 全球使用情况
            otherAttributes.put("guideCountryScore", formatScore(String.valueOf(guideCountry.getFloat("score"))));
            otherAttributes.put("table", new JSONArray());
            otherAttributes.getJSONArray("table").add(Arrays.asList("药品名称", "原研/参比/一致性评价", "生产厂家", "生产企业状态", "全球使用情况"));
            otherAttributes.getJSONArray("table").add(Arrays.asList(drugName, drugSituationString, enterpirceName, enterpriseString, countryString));
            result.put("otherAttributes", otherAttributes);
            countDownLatch.countDown();
        });

        try {
            countDownLatch.await();
        } catch (InterruptedException e) {
            log.error(e.getMessage(), e);
        }
        log.info("app端 gpt分析时长{}", System.currentTimeMillis() - begin);
        result.put("time", DateUtil.formatDateTime(new Date()));
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
                log.error(e.getMessage(), e);
            }
            result.put("overallSummary", overallSummary);
            overallSummary.put("comprehensiveScore", formatScore(vscore.setScale(2, RoundingMode.HALF_UP).toString()));
            overallSummary.put("dimensionDiagram", new JSONArray());
            overallSummary.put("score", vscore.setScale(2, RoundingMode.HALF_UP));
            BigDecimal bigDecimal = vscore.setScale(2, RoundingMode.HALF_UP);
            float value = bigDecimal.floatValue();
            String status;
            if (value > 70) {
                status = "强推荐";
            } else if (value < 60) {
                status = "不推荐";
            } else {
                status = "弱推荐";
            }
            overallSummary.put("recommendation", "临床上治疗" + disease + "疾病时，" + status + "使用" + drugName + "。");
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
            jsonObject5.put("value", result.getJSONObject("economical").getString("vscore"));
            overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        String uuid = UUID.randomUUID().toString();
        result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
        result.put("id", uuid);
        result.put("_id", uuid);
        result.put("drugName", drugName);
        result.put("disease", disease);
        result.put("drugInfo", drugInfo);
        this.mongoTemplate.insert(result, "drug_analyze_data");
        log.info(result.toJSONString());
        log.info("app端花费总时长{}", System.currentTimeMillis() - begin);
        return result;
    }

    @Value("${sys.isDev}")
    private String isDev;


    @Override
    public JSONObject guidePanelApp(String drugInfo, String disease, String specifications, String id, String priceId, long userId, String isCustom) {
        Boolean isExist = this.redisTemplate.hasKey("gpt:" + id + ":" + 0);
        JSONObject result = new JSONObject();
        if (Objects.isNull(isExist) || !isExist) {
            String[] arr = drugInfo.split("-");
            String drugName = arr[0];
            String enterpriseName = arr.length >= 3 ? drugInfo.split("-")[2] : drugInfo.split("-")[1];

            result.put("disease", disease);
            result.put("ts", System.currentTimeMillis());
            result.put("cache_key", drugInfo + "_" + disease);

            // 用来存放drug 和 disease同义词list
            List<String> drugs = new ArrayList<>(Collections.singletonList(drugName));
            List<String> diseases = new ArrayList<>(Collections.singletonList(disease));

            // 拼接返回前端
            List<String> stringBuilder = new ArrayList<>();
            long begin = System.currentTimeMillis();


            // 开始分析的步骤开始 计入redis中
            int step = 0;

            // 缓存
            DrugInfoNew drugInfo1 = null;
            drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpriseName)), DrugInfoNew.class);
            if (drugInfo1 == null) {
                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), DrugInfoNew.class);
            }
            List<JSONObject> jsonObjects;
            if ("1".equals(isDev)) {
                jsonObjects = ChangeMongoUtil.mongo.find(new Query(Criteria.where("cache_key").is(drugInfo + "_" + disease)), JSONObject.class, "evaluation_cache_app");
            } else {
                jsonObjects = mongoTemplate.find(new Query(Criteria.where("cache_key").is(drugInfo + "_" + disease)), JSONObject.class, "evaluation_cache_app");
            }

            if (CollUtil.isNotEmpty(jsonObjects)) {
                // 打字机效果
                JSONObject jsonObject = jsonObjects.get(0);
                JSONArray content = jsonObject.getJSONArray("content");

                boolean isOne = true;
                for (String o : content.toJavaList(String.class)) {
                    if (CacheNameEnum.hasCache(o) && isOne) {
                        // 4.经济性
                        isOne = false;
                        step = economicalAnalysisApp(drugName, disease, drugInfo1, step, id, jsonObject, priceId, enterpriseName, stringBuilder);
                    } else if (!CacheNameEnum.hasCache(o)) {
                        addProcess(id, step++, o, stringBuilder);
                    }
                }

                result = jsonObject;

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
                        log.error(e.getMessage(), e);
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
                    jsonObject5.put("value", result.getJSONObject("economical").getString("vscore"));
                    overallSummary.getJSONArray("dimensionDiagram").add(jsonObject5);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
                result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
                result.put("id", id);
                result.put("_id", id);
                result.put("drugName", drugName);
                result.put("disease", disease);
                result.put("drugInfo", drugInfo);
                this.mongoTemplate.insert(result, "drug_analyze_data");
                JSONObject variousScore = new JSONObject();
                evaluationService.calculateTotalScore(variousScore, result, drugName, disease);
                redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, variousScore, 1, TimeUnit.HOURS);

                return jsonObject;

            }

            addProcess(id, step++, "<p class='text_title'>基于《中国医疗机构药品评价与遴选快速指南(第二版)》中的评价量表，对" + drugName + "治疗" + disease + "进行临床综合评价：</p>", stringBuilder);
            // 获取同义词
            GetSynonyms(drugName, drugs, disease, diseases);

            // 此处存储的key 与 value 的值在获取同义词接口出保存
            String redis_key = "synonym:" + userId;
            String synonym = RedisUtils.getStr(redis_key);
            if (StrUtil.isNotBlank(synonym)) {
                List<SynonymVo> synonymVos = JSON.parseObject(synonym, new TypeReference<List<SynonymVo>>() {
                });
                for (SynonymVo synonymVo : synonymVos) {
                    // 表明输入词有药
                    if (Integer.parseInt(synonymVo.getType()) == 1) {
                        // 要所有已勾选的同义词
                        drugs = new ArrayList<>(CollUtil.union(drugs, synonymVo.getSynonyms()));
                        // 排除所有反勾选的同义词
                        drugs.removeAll(synonymVo.getExcludeSynonyms());
                    }

                    // 如果在研究疾病清单处自定义疾病  那么前一个页面中如果自定义了同义词就不再使用 否则需要使用自定义的同义词
                    if (Integer.parseInt(isCustom) == 0) {
                        if (Integer.parseInt(synonymVo.getType()) == 3) {
                            // 要所有已勾选的同义词
                            diseases = new ArrayList<>(CollUtil.union(diseases, synonymVo.getSynonyms()));
                            // 排除所有反勾选的同义词
                            diseases.removeAll(synonymVo.getExcludeSynonyms());
                        }
                    }
                }
            }


//            if (Objects.nonNull(specifications) && StrUtil.isNotBlank(specifications)) {
//                drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("manufacturer").is(enterpriseName).and("specifications").is(specifications)), DrugInfoNew.class);
//            }

             drugInfo1 = drugInfoUtil.getDrugInfo(drugInfo1.getId(), id);


            Map<String, Future<Boolean>> futureResult = new HashMap<>();
            Map<String, JSONObject> gptAnalysisMap = new HashMap<>();
            Map<GuideVO, JSONObject> guideEffectiveMap = new HashMap<>();
            Map<GuideVO, JSONObject> guideOldEffectiveMap = new HashMap<>();
            Map<Literature, JSONObject> literatureMap = new HashMap<>();

            useThreadPoolExecutePrompt(drugName, disease, drugInfo1, enterpriseName, futureResult, gptAnalysisMap, guideEffectiveMap, guideOldEffectiveMap, literatureMap, new DrugAddDto(), drugs, diseases);

            // 1.药学特性分析
            step = pharmacyAnalysis(drugName, disease, drugInfo1, step, id, result, stringBuilder);

            // 2.有效性部分
            step = effectiveAnalysis(drugName, disease, drugInfo1, step, id, result, futureResult, gptAnalysisMap, guideEffectiveMap, guideOldEffectiveMap, literatureMap, stringBuilder);

            // 3.安全性
            step = safetyAnalysis(drugName, disease, drugInfo1, step, id, result, futureResult, gptAnalysisMap, stringBuilder);

            // 4.经济性
            step = economicalAnalysisApp(drugName, disease, drugInfo1, step, id, result, priceId, enterpriseName, stringBuilder);

            // 5.其他
            step = otherAnalysis(drugName, disease, drugInfo1, step, id, result, enterpriseName, futureResult, gptAnalysisMap, stringBuilder);

            String uuid = UUID.randomUUID().toString();
            result.put("title", drugName + "治疗" + disease + "临床综合评价报告");
            result.put("id", id);
            result.put("_id", id);
            result.put("drugName", drugName);
            result.put("disease", disease);
            result.put("drugInfo", drugInfo);
            this.mongoTemplate.insert(result, "drug_analyze_data");

            JSONObject variousScore = new JSONObject();
            evaluationService.calculateTotalScore(variousScore, result, drugName, disease);
            redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, variousScore, 1, TimeUnit.HOURS);

            log.info(result.toJSONString());
            addProcess(id, step, "-END-", stringBuilder);
            result.put("content", stringBuilder);
            result.put("cacheTitle", drugInfo);
            if ("1".equals(isDev)) {
                ChangeMongoUtil.mongo.insert(result, "evaluation_cache_app");
            } else {
                mongoTemplate.insert(result, "evaluation_cache_app");
            }

            log.info("剩余代码执行花费时长{}", System.currentTimeMillis() - begin);
        }
        return result;
    }

    private void parallelHandleGptAnalysis(String drugName, String disease, String innerContent, String enterpriseName, DrugInfoNew drugInfo, List<GuideVO> guideVOList, List<GuideVO> oldGuideVOList, List<Literature> literatureList, Map<String, Future<Boolean>> futureResult, Map<String, JSONObject> gptAnalysisMap, Map<GuideVO, JSONObject> guideEffectiveMap, Map<GuideVO, JSONObject> guideOldEffectiveMap, Map<Literature, JSONObject> literatureMap) {

        CountDownLatch guideCountDownLatch = new CountDownLatch(2);
        // 指南分析
        for (int i = 0; i < guideVOList.size(); i++) {
            GuideVO searchHit = guideVOList.get(i);
            String txt = searchHit.getPdf_txt();
            int trail = i + 1;
            Future<Boolean> guideEffectiveResult_trail = guideAnalysisThreadPool.submit(() -> {
                JSONObject guideEffective = new JSONObject();
                try {
                    log.info("分析的指南是{}", searchHit.getTitle());
                    long begin = System.currentTimeMillis();
                    guideEffective = guideEffective(searchHit.getTitle(), drugName, disease, StrUtil.isNotBlank(searchHit.getPdf_txt()) ? searchHit.getPdf_txt().length() > 1500 ? searchHit.getPdf_txt().substring(0, 1500) : searchHit.getPdf_txt() : " ");
                    log.info("指南{}gpt分析花费了{}时间", searchHit.getTitle(), System.currentTimeMillis() - begin);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (guideEffective.getString("score") == null) {
                        guideEffective.put("score", 0);
                    }
                    if (guideEffective.getString("reason") == null) {
                        guideEffective.put("reason", "");
                    }
                    if (guideEffective.getString("summary") == null) {
                        guideEffective.put("summary", "");
                    }
                    if (guideEffective.getString("level") == null) {
                        guideEffective.put("level", "");
                    }
                    if (guideEffective.getString("effective") == null) {
                        guideEffective.put("effective", "暂无");
                    }
                    if (guideEffective.getString("advantage") == null) {
                        guideEffective.put("advantage", "");
                    }
                    if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                        guideEffective.put("score", guideEffective.getInteger("score") + 4);
                    }
                }
                guideEffectiveMap.put(searchHit, guideEffective);
                guideCountDownLatch.countDown();
                return true;
            });
            futureResult.put("guideEffective_" + trail, guideEffectiveResult_trail);
        }
        // 文献分析
        for (int i = 0; i < literatureList.size(); i++) {
            Literature literature = literatureList.get(i);
            int trail = i + 1;
            Future<Boolean> literatureResult_trail = guideAnalysisThreadPool.submit(() -> {
                JSONObject literatureAnalysis = new JSONObject();
                try {
                    log.info("分析的文献是{}", literature.getTitle());
                    long begin = System.currentTimeMillis();
                    literatureAnalysis = literatureAnalysis(literature.getTitle(), drugName, disease, StrUtil.isBlank(literature.getSummary()) ? "" : literature.getSummary());
                    log.info("文献{}gpt分析花费了{}时间", literature.getTitle(), System.currentTimeMillis() - begin);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (literatureAnalysis.getString("score") == null) {
                        literatureAnalysis.put("score", 0);
                    }
                    if (literatureAnalysis.getString("reason") == null) {
                        literatureAnalysis.put("reason", "");
                    }
                    if (literatureAnalysis.getString("summary") == null) {
                        literatureAnalysis.put("summary", "");
                    }
                }
                literatureMap.put(literature, literatureAnalysis);
                return true;
            });
            futureResult.put("literature_" + trail, literatureResult_trail);
        }
        // 备用指南分析
        for (int i = 0; i < oldGuideVOList.size(); i++) {
            GuideVO searchHit = oldGuideVOList.get(i);
            String txt = searchHit.getPdf_txt();
            int trail = i + 1;
            Future<Boolean> guideOldEffectiveResult_trail = guideAnalysisThreadPool.submit(() -> {
                JSONObject guideEffective = new JSONObject();
                try {
                    guideCountDownLatch.await();
                    log.info("分析的备用指南是{}", searchHit.getTitle());
                    long begin = System.currentTimeMillis();
                    guideEffective = guideEffective(searchHit.getTitle(), drugName, disease, StrUtil.isNotBlank(searchHit.getPdf_txt()) ? searchHit.getPdf_txt().length() > 1500 ? searchHit.getPdf_txt().substring(0, 1500) : searchHit.getPdf_txt() : " ");
                    log.info("备用指南{}gpt分析花费了{}时间", searchHit.getTitle(), System.currentTimeMillis() - begin);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                } finally {
                    if (guideEffective.getString("score") == null) {
                        guideEffective.put("score", 0);
                    }
                    if (guideEffective.getString("reason") == null) {
                        guideEffective.put("reason", "");
                    }
                    if (guideEffective.getString("summary") == null) {
                        guideEffective.put("summary", "");
                    }
                    if (guideEffective.getString("level") == null) {
                        guideEffective.put("level", "");
                    }
                    if (guideEffective.getString("advantage") == null) {
                        guideEffective.put("advantage", "");
                    }
                    if (StrUtil.isNotBlank(guideEffective.getString("advantage"))) {
                        guideEffective.put("score", guideEffective.getInteger("score") + 4);
                    }
                }
                guideOldEffectiveMap.put(searchHit, guideEffective);
                return true;
            });
            futureResult.put("guideOldEffective_" + trail, guideOldEffectiveResult_trail);
        }

        // 控制药学特性打分在药学特性分析后面
        CountDownLatch countDownLatchPharmacy = new CountDownLatch(1);

        // 控制特殊人群打分在特殊人群后面
        CountDownLatch countDownLatchSpecial = new CountDownLatch(1);

        // 控制其他不良反应在适应症后面分析
        CountDownLatch countDownLatchIndicationAndOtherAdverse = new CountDownLatch(1);

        // 控制药品分析在临床疗效后面
        CountDownLatch countDownLatchClinicalAndDrug = new CountDownLatch(1);

        // 控制企业分析在不良反应后面
        CountDownLatch countDownLatchAdverseAndEnterprise = new CountDownLatch(1);

        // 控制全球分析在药物相互作用后面
        CountDownLatch countDownLatchInteractionAndCountry = new CountDownLatch(1);

        // 药学特性
        Future<Boolean> pharmacyResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject pharmacy = new JSONObject();
            try {
                pharmacy = this.pharmacy(drugName, disease, innerContent);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (pharmacy.getString("pharmacology") == null) {
                    pharmacy.put("pharmacology", "");
                }
                if (pharmacy.getString("disposition") == null) {
                    pharmacy.put("disposition", "");
                }
                if (pharmacy.getString("storage") == null) {
                    pharmacy.put("storage", "");
                }
                if (pharmacy.getString("pharmaceutics") == null) {
                    pharmacy.put("pharmaceutics", "");
                }
                if (pharmacy.getString("usage") == null) {
                    pharmacy.put("usage", "");
                }
                if (pharmacy.getString("period") == null) {
                    pharmacy.put("period", "");
                }
            }
            gptAnalysisMap.put("pharmacy", pharmacy);
            countDownLatchPharmacy.countDown();
//                countDownLatch_4.countDown();
            log.info("pharmacy  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        });  // 1
        futureResult.put("pharmacy", pharmacyResult);

        // 药学特性打分  todo 目前不知道这里打分准不准
        Future<Boolean> pharmacyScoreResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject pharmacyScore = new JSONObject();
            try {
                countDownLatchPharmacy.await();
                JSONObject pharmacy = gptAnalysisMap.get("pharmacy");
                pharmacyScore = this.pharmacyScore(drugName, drugInfo, pharmacy);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (pharmacyScore.getString("pharmacologyScore") == null || !StrUtil.isNumeric(pharmacyScore.getString("pharmacologyScore"))) {
                    pharmacyScore.put("pharmacologyScore", 0);
                }
                if (pharmacyScore.getString("pharmacokineticsScore") == null || !StrUtil.isNumeric(pharmacyScore.getString("pharmacokineticsScore"))) {
                    pharmacyScore.put("pharmacokineticsScore", 0);
                }
                if (pharmacyScore.getString("usageAndDosageScore") == null || !StrUtil.isNumeric(pharmacyScore.getString("usageAndDosageScore"))) {
                    pharmacyScore.put("usageAndDosageScore", 0);
                }
                if (pharmacyScore.getString("storageScore") == null || !StrUtil.isNumeric(pharmacyScore.getString("storageScore"))) {
                    pharmacyScore.put("storageScore", 0);
                }
                if (pharmacyScore.getString("indateScore") == null || !StrUtil.isNumeric(pharmacyScore.getString("indateScore"))) {
                    pharmacyScore.put("indateScore", 0);
                }
            }
            gptAnalysisMap.put("pharmacyScore", pharmacyScore);
            log.info("pharmacyScore  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        });  // 1
        futureResult.put("pharmacyScore", pharmacyScoreResult);

        // 适应症
        Future<Boolean> indicationEffectiveResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject indicationEffective = new JSONObject();
            try {
                indicationEffective = indicationEeffective(drugName, disease, StrUtil.isNotBlank(drugInfo.getIndications()) ? drugInfo.getIndications() : " ");
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (indicationEffective.getString("score") == null) {
                    indicationEffective.put("score", 0);
                }
                if (indicationEffective.getString("process") == null) {
                    indicationEffective.put("process", "");
                }
                indicationEffective.put("score", judgeNumber(indicationEffective.getString("score")));
            }
            gptAnalysisMap.put("indicationEffective", indicationEffective);
            countDownLatchIndicationAndOtherAdverse.countDown();
            log.info("indicationEffective  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 2
        futureResult.put("indicationEffective", indicationEffectiveResult);

        // 临床疗效
        Future<Boolean> clinicalEffectiveResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject clinicalEffective = new JSONObject();
            try {
                clinicalEffective = clinicalEffect(drugName, disease);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (clinicalEffective.getString("score") == null) {
                    clinicalEffective.put("score", 0);
                }
                if (clinicalEffective.getString("process") == null) {
                    clinicalEffective.put("process", "");
                }
                clinicalEffective.put("score", judgeNumber(clinicalEffective.getString("score")));
            }
            gptAnalysisMap.put("clinicalEffective", clinicalEffective);
            countDownLatchClinicalAndDrug.countDown();
            log.info("clinicalEffective  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        });// 3
        futureResult.put("clinicalEffective", clinicalEffectiveResult);

        // 重度不良反应和重度不良反应分析
        String adverseReaction = drugInfo.getAdverseReaction();
        Future<Boolean> adverseReactionAnalysisResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject adverseReactionAnalysis = new JSONObject();
            try {
                adverseReactionAnalysis = adverseReactionAnalysis(drugName, StrUtil.isNotBlank(adverseReaction) ? adverseReaction : null);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (adverseReactionAnalysis.getString("severeAdverseReaction") == null) {
                    adverseReactionAnalysis.put("severeAdverseReaction", "暂无重度不良反应");
                }
                if (adverseReactionAnalysis.getString("mildAdverseReaction") == null) {
                    adverseReactionAnalysis.put("mildAdverseReaction", "暂无中度不良反应");
                }
                if (adverseReactionAnalysis.getString("mildAdverseReactionScore") == null) {
                    adverseReactionAnalysis.put("mildAdverseReactionScore", 0);
                }
                if (adverseReactionAnalysis.getString("severeAdverseReactionScore") == null) {
                    adverseReactionAnalysis.put("severeAdverseReactionScore", 0);
                }
                adverseReactionAnalysis.put("mildAdverseReactionScore", judgeNumber(adverseReactionAnalysis.getString("mildAdverseReactionScore")));
                adverseReactionAnalysis.put("severeAdverseReactionScore", judgeNumber(adverseReactionAnalysis.getString("severeAdverseReactionScore")));
            }
            gptAnalysisMap.put("adverseReactionAnalysis", adverseReactionAnalysis);
            countDownLatchAdverseAndEnterprise.countDown();
            log.info("adverseReactionAnalysis  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 4
        futureResult.put("adverseReactionAnalysis", adverseReactionAnalysisResult);

        // 特殊人群分析
        Future<Boolean> specialCrowdAnalysisResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject specialCrowdAnalysis = new JSONObject();
            try {
                specialCrowdAnalysis = specialCrowdAnalysis(drugName, null);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowdAnalysis.getString("pregnantWomen") == null) {
                    specialCrowdAnalysis.put("pregnantWomen", "");
                }
                if (specialCrowdAnalysis.getString("childrenMedicine") == null) {
                    specialCrowdAnalysis.put("childrenMedicine", "");
                }
                if (specialCrowdAnalysis.getString("geriatricMedicine") == null) {
                    specialCrowdAnalysis.put("geriatricMedicine", "");
                }
                if (specialCrowdAnalysis.getString("liverKidney") == null) {
                    specialCrowdAnalysis.put("liverKidney", "");
                }
            }
            countDownLatchSpecial.countDown();
            gptAnalysisMap.put("specialCrowdAnalysis", specialCrowdAnalysis);
            log.info("specialCrowdAnalysis  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 5
        futureResult.put("specialCrowdAnalysis", specialCrowdAnalysisResult);

        // 特殊人群分析打分
        Future<Boolean> specialCrowdScoreResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject specialCrowdScore = new JSONObject();
            try {
                countDownLatchSpecial.await();
                JSONObject specialCrowdAnalysis = gptAnalysisMap.get("specialCrowdAnalysis");
                specialCrowdScore = specialCrowdScore(specialCrowdAnalysis, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (specialCrowdScore.getString("childrenScore") == null) {
                    specialCrowdScore.put("childrenScore", 0);
                }
                if (specialCrowdScore.getString("geriatricScore") == null) {
                    specialCrowdScore.put("geriatricScore", 0);
                }
                if (specialCrowdScore.getString("pregnantScore") == null) {
                    specialCrowdScore.put("pregnantScore", 0);
                }
                if (specialCrowdScore.getString("lactatingScore") == null) {
                    specialCrowdScore.put("lactatingScore", 0);
                }
                if (specialCrowdScore.getString("liverScore") == null) {
                    specialCrowdScore.put("liverScore", 0);
                }
                if (specialCrowdScore.getString("kidneyScore") == null) {
                    specialCrowdScore.put("kidneyScore", 0);
                }
                specialCrowdScore.put("childrenScore", judgeNumber(specialCrowdScore.getString("childrenScore")));
                specialCrowdScore.put("geriatricScore", judgeNumber(specialCrowdScore.getString("geriatricScore")));
                specialCrowdScore.put("pregnantScore", judgeNumber(specialCrowdScore.getString("pregnantScore")));
                specialCrowdScore.put("lactatingScore", judgeNumber(specialCrowdScore.getString("lactatingScore")));
                specialCrowdScore.put("liverScore", judgeNumber(specialCrowdScore.getString("liverScore")));
                specialCrowdScore.put("kidneyScore", judgeNumber(specialCrowdScore.getString("kidneyScore")));

            }
            gptAnalysisMap.put("specialCrowdScore", specialCrowdScore);
            log.info("specialCrowdScore  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 5
        futureResult.put("specialCrowdScore", specialCrowdScoreResult);

        // 药物相互作用
        Future<Boolean> drugInteractionAnalysisResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject drugInteractionAnalysis = new JSONObject();
            try {
//                countDownLatch_4.await();
                drugInteractionAnalysis = drugInteractionAnalysis(drugName);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (drugInteractionAnalysis.getString("drugInteraction") == null) {
                    drugInteractionAnalysis.put("drugInteraction", "无");
                }
                if (drugInteractionAnalysis.getString("drugInteractionScore") == null) {
                    drugInteractionAnalysis.put("drugInteractionScore", 0);
                }
                drugInteractionAnalysis.put("drugInteractionScore", judgeNumber(drugInteractionAnalysis.getString("drugInteractionScore")));
            }
            gptAnalysisMap.put("drugInteractionAnalysis", drugInteractionAnalysis);
            countDownLatchInteractionAndCountry.countDown();
            log.info("drugInteractionAnalysis  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 6
        futureResult.put("drugInteractionAnalysis", drugInteractionAnalysisResult);

        // 其他不良反应
        Future<Boolean> otherAdverseReactionResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject otherAdverseReactionAnalysis = new JSONObject();
            try {
                countDownLatchIndicationAndOtherAdverse.await();
                otherAdverseReactionAnalysis = otherAdverseReactionAnalysis(drugName);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (otherAdverseReactionAnalysis.getString("otherAdverseReaction") == null) {
                    otherAdverseReactionAnalysis.put("otherAdverseReaction", "无");
                }
                if (otherAdverseReactionAnalysis.getString("otherAdverseReactionScore") == null) {
                    otherAdverseReactionAnalysis.put("otherAdverseReactionScore", 0);
                }
                otherAdverseReactionAnalysis.put("otherAdverseReactionScore", judgeNumber(otherAdverseReactionAnalysis.getString("otherAdverseReactionScore")));
            }
            gptAnalysisMap.put("otherAdverseReactionAnalysis", otherAdverseReactionAnalysis);
            log.info("otherAdverseReactionAnalysis  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 2
        futureResult.put("otherAdverseReactionAnalysis", otherAdverseReactionResult);

        // 安全性打分
//        Future<Boolean> adrsJsonObjectResult = gptAnalysisThreadPool.submit(() -> {
//            long begin = System.currentTimeMillis();
//            JSONObject adrsJsonObject = new JSONObject();
//            try {
//                // GPT3.5
//                // 指南不良反应评分
//                adrsJsonObject = guideAdrsScore(drugName, drugInfo);
//            } catch (Exception e) {
//                log.error(e.getMessage(), e);
//            }
//            gptAnalysisMap.put("adrsJsonObject", adrsJsonObject);
//            log.info("adrsJsonObject  gpt  分析时长{}", System.currentTimeMillis() - begin);
//            return true;
//        }); // 5899
//        futureResult.put("adrsJsonObject", adrsJsonObjectResult);

        // 药品情况分析
//        if (StrUtil.isBlank(drugInfo.getOriginalDrug())
//                && StrUtil.isBlank(drugInfo.getReferenceDrug())
//                && StrUtil.isBlank(drugInfo.getConsistencyDrug())) {
        Future<Boolean> guideDrugSituationResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject guideDrugSituation = new JSONObject();
            try {
                countDownLatchClinicalAndDrug.await();
                guideDrugSituation = guideDrugSituation(drugName, enterpriseName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideDrugSituation.getString("score") == null) {
                    guideDrugSituation.put("score", 0);
                }
                if (guideDrugSituation.getString("process") == null) {
                    guideDrugSituation.put("process", "");
                }
                guideDrugSituation.put("score", judgeNumber(guideDrugSituation.getString("score")));

            }
            gptAnalysisMap.put("guideDrugSituation", guideDrugSituation);
            log.info("guideDrugSituation  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 3
        futureResult.put("guideDrugSituation", guideDrugSituationResult);
//        }

        // 企业情况分析
        Future<Boolean> guideEnterpriseResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject guideEnterprise = new JSONObject();
            try {
                countDownLatchAdverseAndEnterprise.await();
                guideEnterprise = guideEnterprise(enterpriseName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            } finally {
                if (guideEnterprise.getString("score") == null) {
                    guideEnterprise.put("score", 0);
                }
                if (guideEnterprise.getString("process") == null) {
                    guideEnterprise.put("process", "");
                }
                if (guideEnterprise.getString("info") == null) {
                    guideEnterprise.put("info", "");
                }
                guideEnterprise.put("score", judgeNumber(guideEnterprise.getString("score")));
            }
            gptAnalysisMap.put("guideEnterprise", guideEnterprise);
            log.info("guideEnterprise  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 4
        futureResult.put("guideEnterprise", guideEnterpriseResult);

        // 全球使用情况
        Future<Boolean> guideCountryResult = gptAnalysisThreadPool.submit(() -> {
            long begin = System.currentTimeMillis();
            JSONObject guideCountry = new JSONObject();
            try {
                countDownLatchInteractionAndCountry.await();
                guideCountry = guideCountry(drugName, drugInfo);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
                ;
            } finally {
                if (guideCountry.getString("score") == null) {
                    guideCountry.put("score", 0);
                }
                if (guideCountry.getString("process") == null) {
                    guideCountry.put("process", "");
                }
                if (guideCountry.getString("info1") == null) {
                    guideCountry.put("info1", "");
                }
                if (guideCountry.getString("info2") == null) {
                    guideCountry.put("info2", "");
                }
                guideCountry.put("score", judgeNumber(guideCountry.getString("score")));

            }
            gptAnalysisMap.put("guideCountry", guideCountry);
            log.info("guideCountry  gpt  分析时长{}", System.currentTimeMillis() - begin);
            return true;
        }); // 6
        futureResult.put("guideCountry", guideCountryResult);
    }

    private String judgeNumber(String str) {
        if (Objects.nonNull(str)) {
            String value = "0";
            if (StrUtil.isBlank(str)) {
                return value;
            }
            try {
                if (StrUtil.contains(str, ".")) {
                    value = String.valueOf(Float.parseFloat(str));
                } else {
                    value = String.valueOf(Integer.parseInt(str));
                }
            } finally {
                return value;
            }
        }
        return "0";
    }


    @Override
    public DataResult getProcess(String id, int step) {
        if (redisTemplate.hasKey(id)) {
            id = redisTemplate.opsForValue().get(id).toString();
        }
        Object msg = this.redisTemplate.opsForValue().get("gpt:" + id + ":" + step);
        if (Objects.nonNull(msg)) {
//            this.redisTemplate.delete("gpt:" + id + ":" + step);
            step++;
            return DataResult.process(step, msg.toString());
        }

        return DataResult.process(step, "");
    }

    @Override
    public JSONObject guidePanel_bbbbbbak(String drugInfo, String disease, String specifications, String id, String priceId, long userId, String isCustom) {
        return null;
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
        }

        if (number % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(number);
        } else {
            return new DecimalFormat("#.##").format(number);
        }
    }


    private List<String> getMainInfo_v2(String pdfTxt, List<String> drugNames, List<String> diseases) {
        Set<String> resultSet = new HashSet<>();
        List<String> realDrugs = new ArrayList<>();
        List<String> realDiseases = new ArrayList<>();

        drugNames.forEach(drug -> {
            Pattern pattern = Pattern.compile(Pattern.quote(drug));
            Matcher matcher = pattern.matcher(pdfTxt);
            while (matcher.find()) {
                String group = matcher.group();
                realDrugs.add(group);
            }
        });

        diseases.forEach(disease -> {
            Pattern pattern = Pattern.compile(Pattern.quote(disease));
            Matcher matcher = pattern.matcher(pdfTxt);
            while (matcher.find()) {
                String group = matcher.group();
                if (StrUtil.isNotBlank(group)) {
                    realDiseases.add(group);
                }
            }
        });

//        for (String drugName : drugNames) {
//            Pattern pattern = Pattern.compile(drugName);
//            Matcher matcher = pattern.matcher(pdfTxt);
//            while (matcher.find()){
//                String group = matcher.group();
//                realDrugs.add(group);
//            }
//        }
//        for (String disease : diseases) {
//            Pattern pattern = Pattern.compile(disease);
//            Matcher matcher = pattern.matcher(pdfTxt);
//            while (matcher.find()){
//                String group = matcher.group();
//                realDiseases.add(group);
//            }
//        }

        String innerTxt = pdfTxt;
        String drugInnerTxt = pdfTxt;
        for (String realDrug : realDrugs) {
            int indexOf1 = innerTxt.indexOf(realDrug);

            for (String realDisease : realDiseases) {
                int indexOf2 = innerTxt.indexOf(realDisease);
                if (indexOf2 == -1) {
                    continue;
                }
                int maxIndex = Math.max(indexOf1, indexOf2);
                int minIndex = Math.min(indexOf1, indexOf2);
                int abs = maxIndex - minIndex;
                // System.out.printf("indexOf1={%s}，indexOf2={%s}，abs={%s}", indexOf1, indexOf2, abs);
                // System.out.println();
                if (abs > 80) {
                    // 将indexOf2破坏掉
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
                // 将原有结构破坏掉
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
            // System.out.println("----------------------------------------------");
            // 药品检索结束后破坏药品名称 将indexOf1破坏掉
            if (indexOf1 == -1) {
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
     * 将打印机需要显示的数据只展示一行
     *
     * @param info 需要处理的数据
     * @return 只有一行的说明
     */
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

    /**
     * 将打印机需要显示的数据只展示一行
     *
     * @param info 需要处理的数据
     * @return 只有一行的说明
     */
    private String formatInfo1(String info) {
        if (info != null) {
            // 检查是否在无头模式下

            // 创建一个临时的 JFrame 来获取 Graphics 对象
            Frame frame = new Frame();
            frame.setSize(1, 1); // 设置一个非常小的尺寸以减少资源消耗
            frame.setVisible(true);
            Graphics g = frame.getGraphics();
            if (g == null) {
                return info; // 如果无法获取 Graphics 对象，返回原始信息
            }

            try {
                // 璁剧疆瀛椾綋
                Font font = new Font("Microsoft YaHei", Font.PLAIN, 14);
                g.setFont(font);
                FontMetrics fm = g.getFontMetrics();

                // 璁＄畻瀛楃涓茬殑瀹為檯瀹藉害
                // 这里可以根据需要进行进一步的处理
            } finally {
                // 释放资源
                g.dispose();
                frame.dispose();
            }
        }
        return info;
    }


    public static boolean canParseFloat(String s) {
        try {
            Float.parseFloat(s);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
