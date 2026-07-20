package com.sentum.util;

import cn.hutool.http.HtmlUtil;
import com.alibaba.dashscope.aigc.generation.GenerationOutput;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.Retryer;
import com.alibaba.dashscope.aigc.generation.Generation;
import com.alibaba.dashscope.aigc.generation.GenerationParam;
import com.alibaba.dashscope.aigc.generation.GenerationResult;
import com.alibaba.dashscope.common.Message;
import com.alibaba.dashscope.common.Role;
import com.alibaba.dashscope.exception.ApiException;
import com.alibaba.dashscope.exception.InputRequiredException;
import com.alibaba.dashscope.exception.NoApiKeyException;
import com.alibaba.dashscope.utils.JsonUtils;
import com.sentum.constants.Constants;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import javax.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Lock;
import java.util.stream.Collectors;

/**
 * 调用gpt的方法
 */
@Slf4j
@Component
public class GptAiUtils {



//    @Autowired
//    private RedisTemplate redisTemplate;


    //deepseek
//    private String apiKey = "REDACTED_API_KEY";
    private String baseUrl = "https://api.deepseek.com/chat/completions";
    private String model = "deepseek-chat";
    //gpt
    //private String apiKey = "REDACTED_API_KEY";
    //private String gptBaseUrl = "https://api.chatanywhere.org/v1/chat/completions";
    private String gptBaseUrl = "https://api.chatanywhere.tech/v1/chat/completions";

    //private String model = "gpt-4-1106-preview";
//    @Value("${gpt.key}")
//    private String gptApiKey;

    private static Map<String, Integer> orderMap = new HashMap<>();
    private static Map<Integer, String> orderNum = new HashMap<>();
    static {
        String orderStr = "①、②、③、④、⑤、⑥、⑦、⑧、⑨、⑩、⑪、⑫、⑬、⑭、⑮、⑯、⑰、⑱、⑲、⑳、㉑、㉒、㉓、㉔、㉕、㉖、㉗、㉘、㉙、㉚、㉛、㉜、㉝、㉞、㉟、㊱、㊲、㊳、㊴、㊵、㊶、㊷、㊸、㊹、㊺、㊻、㊼、㊽、㊾、㊿";
        String[] split = orderStr.split("、");
        for (int i = 0; i < split.length; i++) {
            orderMap.put(split[i], i + 1);
            orderNum.put(i + 1, split[i]);
        }
    }

    @Autowired
    private OkHttpUtil okHttpUtil;


    // 静态的key列表
    private static final List<String> keys = new ArrayList<>();
    // 静态索引变量
    private static int currentIndex = 0;

    private static List<String> loadKeys(String name) {
        return Arrays.asList(requiredEnv(name).split("\\s*,\\s*"));
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }

    // 获取下一个key
    public static synchronized String getNextKey() {
        if (keys.isEmpty()) {
            keys.addAll(loadKeys("EVIMED_LEGACY_LLM_API_KEYS"));
        }
        // 使用索引获取当前key
        String currentKey = keys.get(currentIndex);
        // 更新索引，使用取模操作确保索引在列表范围内
        currentIndex = (currentIndex + 1) % keys.size();
        return currentKey;
    }



    /**
     * 调用gpt返回字符串格式数据
     * @param message 问题
     * @return 返回结果解析后的数据
     */
    public String infoChat(String message) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        JSONObject json = new JSONObject();
        json.put("model", model);
        json.put("messages", new JSONArray());
        JSONObject dataJson = new JSONObject();
        dataJson.put("role", "user");
        dataJson.put("content", message);
        json.getJSONArray("messages").add(dataJson);
        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
        String nextKey = getNextKey();
        Request request = new Request.Builder()
                .url(baseUrl)
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " +nextKey )
                .post(body)
                .build();
        //返回
        try (Response response = client.newCall(request).execute()) {
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    StringBuilder builder = new StringBuilder();
                    InputStream inputStream = responseBody.byteStream();
                    byte[] buffer = new byte[1024];
                    int bytesRead;
                    while ((bytesRead = inputStream.read(buffer)) != -1) {
                        builder.append(new String(buffer, 0, bytesRead));
                    }
                    String s = builder.toString();
                    if (StringUtils.isNotBlank(s)) {
                        JSONObject jsonObject = JSONObject.parseObject(s);
                        return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                    }
                }
            } else {
                System.out.println("请求异常: " + response);
                //请求异常之后重试
                //return infoChat(message);
                //return request.toString();
                //return "请求异常";
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
        return null;
    }

    /**
     * 调用gpt返回字符串格式数据
     * @param message 问题
     * @return 返回结果解析后的数据
     */
//    public String infoChat_1(String message, String model) {
//        OkHttpClient client = new OkHttpClient()
//                .newBuilder()
//                .connectTimeout(120, TimeUnit.SECONDS)
//                .readTimeout(120, TimeUnit.SECONDS)
//                .writeTimeout(120, TimeUnit.SECONDS)
//                .hostnameVerifier(new AllowAllHostnameVerifier())
//                .build();
//        JSONObject json = new JSONObject();
//        json.put("model", model);
//        json.put("messages", new JSONArray());
//        JSONObject dataJson = new JSONObject();
//        dataJson.put("role", "user");
//        dataJson.put("content", message);
//        json.getJSONArray("messages").add(dataJson);
//        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
//        Request request = new Request.Builder()
//                .url(gptBaseUrl)
//                .addHeader("Content-Type", "application/json")
//                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
//                .addHeader("Authorization", "Bearer " + gptApiKey)
//                .post(body)
//                .build();
//        //返回
//        try (Response response = client.newCall(request).execute()) {
//            if (response.isSuccessful()) {
//                ResponseBody responseBody = response.body();
//                if (responseBody != null) {
//                    StringBuilder builder = new StringBuilder();
//                    String line;
//                    BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
//                    while ((line = reader.readLine()) != null) {
//                        builder.append(line);
//                    }
//                    /*InputStream inputStream = responseBody.byteStream();
//                    byte[] buffer = new byte[1024];
//                    int bytesRead;
//                    while ((bytesRead = inputStream.read(buffer)) != -1) {
//                        builder.append(new String(buffer, 0, bytesRead));
//                    }*/
//                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
//                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
//                }
//            } else {
//                System.out.println("请求异常: " + response);
//                //return request.toString();
//                //return infoChat(message, model);
//                //return "请求异常";
//                return "";
//            }
//        } catch (IOException e) {
//            e.printStackTrace();
//        }
//        return null;
//    }

    /**
     * 调用gpt返回字符串格式数据
     * @param message 问题
     * @return 返回结果解析后的数据
     */
    public String infoChat(String message, String model) {
        JSONObject json = new JSONObject();
        json.put("model", model);
        json.put("messages", new JSONArray());
        JSONObject dataJson = new JSONObject();
        dataJson.put("role", "user");
        dataJson.put("content", message);
        json.getJSONArray("messages").add(dataJson);
        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
        //返回
        Response response = okHttpUtil.response(body);
        try {
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    StringBuilder builder = new StringBuilder();
                    String line;
                    BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                    while ((line = reader.readLine()) != null) {
                        builder.append(line);
                    }
                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
        return "";
    }

    /**
     * 调用gpt返回字符串格式数据
     * @param message 问题
     * @return 返回结果解析后的数据
     */
    public String infoChat(String message, String model, Double temperature) {
        JSONObject json = new JSONObject();
        json.put("model", model);
        json.put("temperature", temperature);
        json.put("messages", new JSONArray());
        JSONObject dataJson = new JSONObject();
        dataJson.put("role", "user");
        dataJson.put("content", message);
        json.getJSONArray("messages").add(dataJson);
        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
        //返回
        Response response = okHttpUtil.response(body);
        try {
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    StringBuilder builder = new StringBuilder();
                    String line;
                    BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                    while ((line = reader.readLine()) != null) {
                        builder.append(line);
                    }
                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                }
            }
            response.close();
        } catch (IOException e) {
            e.printStackTrace();
        }
        return "";
    }

    public String infoChatByTool(String message, String model, JSONObject responseFormat) {
        JSONObject json = new JSONObject();
        json.put("model", model);
        json.put("response_format", responseFormat);
        json.put("messages", new JSONArray());
        JSONObject dataJson = new JSONObject();
        dataJson.put("role", "user");
        dataJson.put("content", message);
        json.getJSONArray("messages").add(dataJson);
        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
        //返回
        try (Response response = okHttpUtil.response(body)) {
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    StringBuilder builder = new StringBuilder();
                    InputStream inputStream = responseBody.byteStream();
                    byte[] buffer = new byte[1024];
                    int bytesRead;
                    while ((bytesRead = inputStream.read(buffer)) != -1) {
                        builder.append(new String(buffer, 0, bytesRead));
                    }
                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                }
            } else {
                System.out.println("请求异常: " + response);
                return "";
            }
            response.close();
        } catch (IOException e) {
            e.printStackTrace();
        }
        return null;
    }



    // public String infoChatBySystem(String message, String model, String system) {
    //     JSONObject json = new JSONObject();
    //     json.put("model", model);
    //     json.put("messages", new JSONArray());
    //     JSONObject dataJson = new JSONObject();
    //     JSONObject dataJsonSys = new JSONObject();
    //     dataJsonSys.put("role", "system");
    //     dataJsonSys.put("content", system);
    //     dataJson.put("role", "user");
    //     dataJson.put("content", message);
    //     json.getJSONArray("messages").add(dataJson);
    //     json.getJSONArray("messages").add(dataJsonSys);
    //
    //     JSONObject object = new JSONObject();
    //     object.put("type", "json_object");
    //     json.put("response_format", object);
    //
    //     RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
    //     //返回
    //     try (Response response = okHttpUtil.responseBailian(body)) {
    //         if (response.isSuccessful()) {
    //             ResponseBody responseBody = response.body();
    //             if (responseBody != null) {
    //                 StringBuilder builder = new StringBuilder();
    //                 InputStream inputStream = responseBody.byteStream();
    //                 byte[] buffer = new byte[1024];
    //                 int bytesRead;
    //                 while ((bytesRead = inputStream.read(buffer)) != -1) {
    //                     builder.append(new String(buffer, 0, bytesRead));
    //                 }
    //                 JSONObject jsonObject = JSONObject.parseObject(builder.toString());
    //                 return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
    //             }
    //         } else {
    //             System.out.println("请求异常: " + response);
    //             return "";
    //         }
    //         response.close();
    //     } catch (IOException e) {
    //         e.printStackTrace();
    //     }
    //     return null;
    // }


    public String infoChatBySystem(String message, String model, String system) {


        HashMap<String, Object> objectObjectHashMap = new HashMap<>();
        if (StringUtils.isNotEmpty(system)) {
            //格式化返回
            JSONObject object = new JSONObject();
            object.put("type", "json_object");
            objectObjectHashMap.put("response_format", object);

            if (model.contains("thinking")){
                // 开启思考模式
                objectObjectHashMap.put("enable_thinking", true);
                // 可选：设置最大思考步数
                objectObjectHashMap.put("max_thinking_steps", 5);
            }

        }else {
            JSONObject object = new JSONObject();
            object.put("type", "text");
            objectObjectHashMap.put("response_format", object);
        }

        if (StringUtils.isEmpty(system)){
            system = "请你作为一个医学专家完成任务";
        }

        Generation gen = new Generation();
        Message systemMsg = Message.builder()
                .role(Role.SYSTEM.getValue())
                .content(system)
                .build();
        Message userMsg = Message.builder()
                .role(Role.USER.getValue())
                .content(message)
                .build();


        if (StringUtils.isEmpty(model)){
            model = "qwen3-235b-a22b-instruct-2507";
        }



        GenerationParam param = GenerationParam.builder()
                // 若没有配置环境变量，请用百炼API Key将下行替换为：.apiKey("sk-xxx")
                .apiKey(requiredEnv("DASHSCOPE_API_KEY"))
                // 此处以qwen-plus为例，可按需更换模型名称。模型列表：https://help.aliyun.com/zh/model-studio/getting-started/models
                .model(model)
                .messages(Arrays.asList(systemMsg, userMsg))
                .resultFormat(GenerationParam.ResultFormat.MESSAGE)
                .parameters(objectObjectHashMap)

                .build();

     try {
         GenerationResult call;

        try {
           call = gen.call(param);

            GenerationOutput output = call.getOutput();
            List<GenerationOutput.Choice> choices = output.getChoices();
            for (GenerationOutput.Choice choice : choices) {
               return choice.getMessage().getContent();
            }


            log.info("{}", call.getOutput().getText());
            log.info("{}", call.getOutput().getChoices());
        } catch (NoApiKeyException e) {
            throw new RuntimeException(e);
        } catch (InputRequiredException e) {
            throw new RuntimeException(e);
        }
     }catch (Exception e){

         log.error("模型调用出错{}**********{}********{}", e,message,system);

     }
        return "";
    }



    public JSONObject executeGptPlusNoArray(String query, String name, String jsonObject1, String model, String score) {
        JSONObject jsonObject = new JSONObject();
        String modelName = model;
        if (org.apache.commons.lang.StringUtils.isEmpty(model)) {
            modelName = "qwen3-235b-a22b-instruct-2507";
        }

        // ===== 新增：生成缓存Key =====
//        String cacheKey = generateCacheKey(query, score);
////        // 尝试从缓存获取（仅当主流程失败时生效）
////        JSONObject cachedResult = tryGetFromCache(cacheKey);
//        if (cachedResult != null) {
//            log.info("{} 使用缓存结果 key={}", name, cacheKey);
//            return cachedResult;
//        }

        if (org.apache.commons.lang.StringUtils.isNotEmpty(score)) {
            String[] split = score.split(",");
            // 数组转为可视化的list
            String list = Arrays.stream(split).map(item -> "\"" + item + "\"").collect(Collectors.joining(","));
            query += "*****得分相关的返回必须是" + list + "中的某个数值，不可以出现不存在的数值，你给我返回的结果中，除了得分之外，分析结果中请不要包含根据我给出的哪一条规则判断给出的评分，这样的字眼，直接输出相关分析结果就好。如：‘在评分规则第（6）项中已经指示将其视为西医病。’\\n 还有若出现null则表示无相关信息，无视即可，不要返回null相关字眼";
        }

        if (StringUtils.isNotEmpty(jsonObject1)) {
            query += jsonObject1;
        }
        String result = youyideyi(query, jsonObject1, modelName);



        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        try {
            jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
//            // ===== 新增：成功结果缓存 =====
//            cacheSuccessfulResult(cacheKey, jsonObject);
        } catch (Exception e) {
            log.info(name + "进行了分析");
            log.info("GPT分析的问题是:{}", query);
            log.info("----经过GPT分析出来的结果是{}", result);
            try {
                String result1 = youyideyi(query + "***************严格以json格式返回*************", jsonObject1, modelName);
                jsonObject = JSONObject.parseObject(result1.substring(start, end + 1));
//                // ===== 新增：成功结果缓存 =====
//                cacheSuccessfulResult(cacheKey, jsonObject);
            } catch (Exception ex) {
                log.info(name + "进行了分析");
                log.info("GPT分析的问题是:{}", query);
                log.info("----经过GPT分析出来的结果是{}", result);
//                // ===== 新增：重试失败后尝试缓存 =====
//                JSONObject cacheFallback = tryGetFromCache(cacheKey);
//                if (cacheFallback != null) {
//                    log.warn("{} 重试失败，使用缓存结果 key={}", name, cacheKey);
//                    return cacheFallback;
//                }
            }
        }

        // ===== 新增：最终返回前缓存成功结果 =====
//        if (jsonObject != null && !jsonObject.isEmpty()) {
//            cacheSuccessfulResult(cacheKey, jsonObject);
//        }
        return jsonObject;
    }





    public JSONObject executeGptPlus(String query, String name, String jsonObject1, String model, String score) {
        JSONObject jsonObject = new JSONObject();
        String modelName = model;
        if (org.apache.commons.lang.StringUtils.isEmpty(model)) {
            modelName = "qwen3-235b-a22b-instruct-2507";
        }

        // ===== 新增：生成缓存Key =====
//        String cacheKey = generateCacheKey(query, score);
////        // 尝试从缓存获取（仅当主流程失败时生效）
////        JSONObject cachedResult = tryGetFromCache(cacheKey);
//        if (cachedResult != null) {
//            log.info("{} 使用缓存结果 key={}", name, cacheKey);
//            return cachedResult;
//        }

        if (org.apache.commons.lang.StringUtils.isNotEmpty(score)) {
            String[] split = score.split(",");
            // 数组转为可视化的list
            String list = Arrays.stream(split).map(item -> "\"" + item + "\"").collect(Collectors.joining(","));
            query += "*****得分相关的返回必须是" + list + "中的某个数值，不可以出现不存在的数值，你给我返回的结果中，除了得分之外，分析结果中请不要包含根据我给出的哪一条规则判断给出的评分，这样的字眼，直接输出相关分析结果就好。如：‘在评分规则第（6）项中已经指示将其视为西医病。’\\n 还有若出现null则表示无相关信息，无视即可，不要返回null相关字眼";
        }

        if (StringUtils.isNotEmpty(jsonObject1)) {
            query += jsonObject1;
        }
        String result = youyideyi(query, jsonObject1, modelName);

        if (result.contains("[") && result.contains("]")) {
            try {
                int start1 = result.indexOf('[');
                int end1 = result.lastIndexOf(']');
                JSONArray objects = JSONObject.parseArray(result.substring(start1, end1 + 1));
                jsonObject.put("array", objects);
//                // ===== 新增：成功结果缓存 =====
//                cacheSuccessfulResult(cacheKey, jsonObject);
                return jsonObject;
            } catch (Exception e) {
                log.info(name + "进行了分析");
                log.info("GPT分析的问题是:{}", query);
                log.info("----经过GPT分析出来的结果是{}", result);
                int start = result.indexOf('{');
                int end = result.lastIndexOf('}');
                try {
                    jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
//                    // ===== 新增：成功结果缓存 =====
//                    cacheSuccessfulResult(cacheKey, jsonObject);
                    return jsonObject;
                } catch (Exception ex) {
                    log.info(name + "进行了分析");
                    log.info("GPT分析的问题是:{}", query);
                    log.info("----经过GPT分析出来的结果是{}", result);
                    try {
                        String result1 = youyideyi(query + "***************严格以json格式返回*************", jsonObject1, modelName);
                        jsonObject = JSONObject.parseObject(result1.substring(start, end + 1));
//                        // ===== 新增：成功结果缓存 =====
//                        cacheSuccessfulResult(cacheKey, jsonObject);
                        return jsonObject;
                    } catch (Exception exc) {
                        log.info(name + "进行了分析");
                        log.info("GPT分析的问题是:{}", query);
                        log.info("----经过GPT分析出来的结果是{}", result);
                        // ===== 新增：重试失败后尝试缓存 =====
//                        JSONObject cacheFallback = tryGetFromCache(cacheKey);
//                        if (cacheFallback != null) {
//                            log.warn("{} 重试失败，使用缓存结果 key={}", name, cacheKey);
//                            return cacheFallback;
//                        }
                    }
                }
            }
        }

        int start = result.indexOf('{');
        int end = result.lastIndexOf('}');
        try {
            jsonObject = JSONObject.parseObject(result.substring(start, end + 1));
//            // ===== 新增：成功结果缓存 =====
//            cacheSuccessfulResult(cacheKey, jsonObject);
        } catch (Exception e) {
            log.info(name + "进行了分析");
            log.info("GPT分析的问题是:{}", query);
            log.info("----经过GPT分析出来的结果是{}", result);
            try {
                String result1 = youyideyi(query + "***************严格以json格式返回*************", jsonObject1, modelName);
                jsonObject = JSONObject.parseObject(result1.substring(start, end + 1));
//                // ===== 新增：成功结果缓存 =====
//                cacheSuccessfulResult(cacheKey, jsonObject);
            } catch (Exception ex) {
                log.info(name + "进行了分析");
                log.info("GPT分析的问题是:{}", query);
                log.info("----经过GPT分析出来的结果是{}", result);
//                // ===== 新增：重试失败后尝试缓存 =====
//                JSONObject cacheFallback = tryGetFromCache(cacheKey);
//                if (cacheFallback != null) {
//                    log.warn("{} 重试失败，使用缓存结果 key={}", name, cacheKey);
//                    return cacheFallback;
//                }
            }
        }

        // ===== 新增：最终返回前缓存成功结果 =====
//        if (jsonObject != null && !jsonObject.isEmpty()) {
//            cacheSuccessfulResult(cacheKey, jsonObject);
//        }
        return jsonObject;
    }

    // ===== 新增辅助方法 =====
    private String generateCacheKey(String query, String score) {
        String baseKey = "GPT_RESULT:" + DigestUtils.md5Hex(query) + ":" + (StringUtils.isEmpty(score) ? "NOSCORE" : score);
        return Base64.getEncoder().encodeToString(baseKey.getBytes(StandardCharsets.UTF_8));
    }

//    private JSONObject tryGetFromCache(String cacheKey) {
//        try {
//            String cached = redisTemplate.opsForValue().get(cacheKey).toString();
//            if (StringUtils.isNotEmpty(cached)) {
//                return JSONObject.parseObject(cached);
//            }
//        } catch (Exception e) {
//            log.warn("缓存读取失败 key={}", cacheKey);
//        }
//        return null;
//    }

//    private void cacheSuccessfulResult(String cacheKey, JSONObject result) {
//        try {
//            if (result != null && !result.isEmpty()) {
//                redisTemplate.opsForValue().set(
//                        cacheKey,
//                        result.toJSONString(),
//                        300, TimeUnit.MINUTES
//                );
//            }
//        } catch (Exception e) {
//            log.error("缓存结果失败 key={}", cacheKey, e);
//        }
//    }


    private final Map<String, Lock> lockMap = new ConcurrentHashMap<>();


    public String youyideyi(String msg, String responseFormat, String model) {
        // log.info("*****************youyideyi msg:{}*************", msg);
        String cleanedText = msg.replaceAll("[^\\p{L}\\p{N}\\p{IsHan}]+", "");
        cleanedText = cleanedText + responseFormat + model;
        String md5 = SecurityUtil.getMd5(cleanedText);


        // 获取当前 md5 对应的锁
        // Lock lock = lockMap.computeIfAbsent(md5, k -> new ReentrantLock());
        // lock.lock();
        try {
            // 再次检查缓存是否存在，防止并发下重复计算
            long ts = System.currentTimeMillis();
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
            jsonObject1.put("model", model);
            jsonObject1.put("responseFormat", responseFormat);

            String response = null;
            try {
                Retryer retryer = GuavaRetryer.createRetryer();
                response = (String) retryer.call(() -> infoChatBySystem(msg, model, responseFormat));

                String requestBody = jsonObject1.toJSONString();
                int length = response.length();
                int length1 = response.getBytes("UTF-8").length;

                int requestCharCount = requestBody.length() + length;
                int requestByteCount = requestBody.getBytes("UTF-8").length + length1;



            } catch (Exception e) {
                log.error(e.getMessage() + "*********gpt调用失败*************prompt:" + msg, e);
            }

            log.info("call gpt cost time:{}", System.currentTimeMillis() - ts);

            if (org.apache.commons.lang.StringUtils.isNotEmpty(response)) {
                // 清洗响应内容
                String cleanedResponse = response
                        .replaceAll("\\uFFFD", "")
                        .replaceAll("\\\\n", "")
                        .replaceAll("\\*", "")
                        .replaceAll("#", "")
                        .replaceAll("(?<!\\\\)(\\\\[^\\\\n])|\\\\", "")
                        .replaceAll("[\r\n]", "");


                log.info("GPT返回的结果是:{}", cleanedResponse);

                return cleanedResponse;
            }
            return "";
        } finally {
            // lock.unlock(); // 释放锁
        }
    }





    /**
     * deepSeek模型不带参考文献--流处理返回
     * @param response HttpServletResponse
     * @param id 检索id
     * @param type 3 ai方案
     * @param  +prompt
     * @param
     */
//    public void deepSeekFlowType(HttpServletResponse response,String inputWords,String id,Integer type,StringBuilder builder) {
//        if (type == 3) {
//            model = "gpt-4o-mini";
//            //baseUrl = "https://api.chatanywhere.tech/v1/chat/completions";
//            baseUrl = gptBaseUrl;
//            //apiKey = "REDACTED_API_KEY";
//            apiKey = gptApiKey;
//        }
//        JSONArray messages = new JSONArray();
//        OkHttpClient client = new OkHttpClient()
//                .newBuilder()
//                .connectTimeout(120, TimeUnit.SECONDS)
//                .readTimeout(120, TimeUnit.SECONDS)
//                .writeTimeout(120, TimeUnit.SECONDS)
//                .hostnameVerifier(new AllowAllHostnameVerifier())
//                .build();
//        JSONObject json = new JSONObject();
//        json.put("model", model);
//        json.put("messages", messages);
//        JSONObject dataJson = new JSONObject();
//        dataJson.put("role", "user");
//        dataJson.put("content", inputWords);
//        messages.add(dataJson);
//        //流式数据
//        json.put("stream", true);
//        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
//        Request request = new Request.Builder()
//                .url(baseUrl)
//                .addHeader("Content-Type", "application/json")
//                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
//                .addHeader("Authorization", "Bearer " + apiKey)
//                .post(body)
//                .build();
//        //流式返回
//        Response outResponse = null;
//        try {
//            outResponse = client.newCall(request).execute();
//            ResponseBody responseBody = null;
//            if (outResponse.isSuccessful()) {
//                responseBody = outResponse.body();
//            } else {
//                System.out.println("流式请求异常: " + outResponse);
//                log.info("重试");
//                outResponse = client.newCall(request).execute();
//                if (outResponse.isSuccessful()) {
//                    responseBody = outResponse.body();
//                }
//            }
//            if (responseBody != null) {
//                String line;
//                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
//                while ((line = reader.readLine()) != null) {
//                    if (StringUtils.isBlank(line)) {
//                        continue;
//                    }
//                    //System.out.println(line);
//                    line = line.replaceAll("data: ", "");
//                    if ("[DONE]".equals(line) || "{\"error\":{\"message\":\"\",\"type\":\"chatanywhere_error\",\"param\":null,\"code\":\"200 OK\"}}".equals(line)) {
//                        continue;
//                    }
//                    JSONObject jsonObject = JSONObject.parseObject(line);
//                    JSONArray choicesArr = jsonObject.getJSONArray("choices");
//                    if (CollUtil.isEmpty(choicesArr)) {
//                        continue;
//                    }
//                    JSONObject choices = choicesArr.getJSONObject(0);
//                    String finishReason = choices.getString("finish_reason");
//                    if (StringUtils.isNotBlank(finishReason) && "stop".equals(finishReason)) {
//                        continue;
//                    }
//                    String text = choices.getJSONObject("delta").getString("content");
//                    response.getWriter().write("id: "+ id +"\n");
//                    response.getWriter().write("event :overview\n");
//                    if (text != null) {
//                        if (text.contains("\n\n")) {
//                            text = text.replaceAll("\n\n", "<br/>");
//                        } else if (text.contains("\n")) {
//                            text = text.replaceAll("\n", "<br/>");
//                        }
//                        if (text.contains("#")) {
//                            text = text.replaceAll("#", "");
//                            text = text.replaceAll("##", "");
//                            text = text.replaceAll("###", "");
//                            text = text.replaceAll("####", "");
//                        }
//                        if (text.contains("*")) {
//                            text = text.replaceAll("\\*", "");
//                            text = text.replaceAll("\\*\\*", "");
//                        }
//                        response.getWriter().write("data: " + text + "\n\n");
//                        response.getWriter().flush();
//                        if (type == 3) {
//                            builder.append(text);
//                            /*AiProgrammeInfo aiProgrammeInfo = new AiProgrammeInfo();
//                            aiProgrammeInfo.setId(id);
//                            aiProgrammeInfo.setText(text);
//                            KafkaSenderUtils.sender.sendProgramme(id, aiProgrammeInfo);*/
//                        }
//                        Thread.sleep(20);
//                    }
//                }
//            }
//        } catch (IOException | InterruptedException e) {
//            e.printStackTrace();
//        } finally {
//            if (outResponse != null) {
//                outResponse.close();
//            }
//        }
//    }


    public void write(String id, String text, HttpServletResponse response, Integer type, StringBuilder allBuilder) throws IOException {
        if (type == 1) {
            Boolean aBoolean = RedisUtil.redis.hasKey(id);
            if (aBoolean != null && aBoolean) {
                //关闭流
                response.getWriter().close();
                return;
            }
        }
        try {
            response.getWriter().write("id: "+id+"\n");
            // 指定事件标识  event: 这个为固定格式
            response.getWriter().write("event :overview\n");
            // 格式：data: + 数据 + 2个回车
            //System.out.println(text);
            /*if (text.contains("卍")){
                text = text.replaceAll("卍","<br/><br/>");
            }*/
            if (text.contains("\n\n")) {
                text = text.replaceAll("\n\n", "<br/>");
            } else if (text.contains("\n")) {
                text = text.replaceAll("\n", "<br/>");
            }
            //Thread.sleep(20);
            response.getWriter().write("data: " + text + "\n\n");
            response.getWriter().flush();
            /*if (type == 1) {
                MessageInfo messageInfo = new MessageInfo();
                messageInfo.setId(id);
                messageInfo.setMsg(text);
                KafkaSenderUtils.sender.sendMessage(id, messageInfo);
            }else if (type == 3){
                AiProgrammeInfo aiProgrammeInfo = new AiProgrammeInfo();
                aiProgrammeInfo.setId(id);
                aiProgrammeInfo.setText(text);
                KafkaSenderUtils.sender.sendProgramme(id,aiProgrammeInfo);
                allBuilder.append(text);
            }*/
            if (type == 3){
                allBuilder.append(text);
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    public void writeJson(String text, StringBuilder textBuilder, HttpServletResponse response) {
        textBuilder.append(text);
        if (response != null) {
            try {
                response.getWriter().write("id: " + "" + "\n");
                // 指定事件标识  event: 这个为固定格式
                response.getWriter().write("event :overview\n");
                JSONObject inner = new JSONObject();
                inner.put("data", text);
                response.getWriter().write("data: " + inner.toJSONString() + "\n\n");
                //response.getWriter().write("data: " + text + "\n\n");
                response.getWriter().flush();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }


    /**
     * 调用gpt返回字符串格式数据
     * @param messages 问题
     * @param model 模型
     * @return 返回结果解析后的数据
     */
//    public String infoChatForAiSearch(JSONArray messages, String model) {
//        OkHttpClient client = new OkHttpClient()
//                .newBuilder()
//                .connectTimeout(120, TimeUnit.SECONDS)
//                .readTimeout(120, TimeUnit.SECONDS)
//                .writeTimeout(120, TimeUnit.SECONDS)
//                .hostnameVerifier(new AllowAllHostnameVerifier())
//                .build();
//        JSONObject json = new JSONObject();
//        json.put("model", model);
//        json.put("messages", messages);
//        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
//        Request request = new Request.Builder()
//                .url(gptBaseUrl)
//                .addHeader("Content-Type", "application/json")
//                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
//                .addHeader("Authorization", "Bearer " + gptApiKey)
//                .post(body)
//                .build();
//        //返回
//        try (Response response = client.newCall(request).execute()) {
//            if (response.isSuccessful()) {
//                ResponseBody responseBody = response.body();
//                if (responseBody != null) {
//                    StringBuilder builder = new StringBuilder();
//                    InputStream inputStream = responseBody.byteStream();
//                    byte[] buffer = new byte[1024];
//                    int bytesRead;
//                    while ((bytesRead = inputStream.read(buffer)) != -1) {
//                        builder.append(new String(buffer, 0, bytesRead));
//                    }
//                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
//                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
//                }
//            } else {
//                System.out.println("请求异常: " + response);
//                //return request.toString();
//                //return infoChat(message, model);
//                //return "请求异常";
//                return "";
//            }
//        } catch (IOException e) {
//            e.printStackTrace();
//        }
//        return null;
//    }



//    public String callGptApi(String message, String model,String rule) {
//        JSONObject json = new JSONObject();
//        json.put("model", model);
//        // 构建 messages 部分
//        JSONArray messages = new JSONArray();
//        // system message
//        JSONObject systemMessage = new JSONObject();
//        systemMessage.put("role", "system");
//        systemMessage.put("content", message);
//        messages.add(systemMessage);
//
//        JSONObject userMessage = new JSONObject();
//        userMessage.put("role", "user");
//        userMessage.put("content", rule);
//        messages.add(userMessage);
//        json.put("messages", messages);
//
//        // 构建 response_format 部分
//        JSONObject responseFormat = new JSONObject();
//        responseFormat.put("type", "json_schema");
//
//        // 构建 json_schema 部分
//        JSONObject jsonSchema = new JSONObject();
//        jsonSchema.put("name", "action_items");
//        jsonSchema.put("strict", true);
//
//        // schema 定义
//        JSONObject schema = new JSONObject();
//        schema.put("type", "object");
//        JSONObject properties = new JSONObject();
//
//        JSONObject reasoning_steps = new JSONObject();
//        reasoning_steps.put("type","array");
//        JSONObject items = new JSONObject();
//        items.put("type","string");
//        reasoning_steps.put("items",items);
//        reasoning_steps.put("description",rule);
//        JSONObject answer = new JSONObject();
//        answer.put("type","string");
//        answer.put("description","XXXXXX的描述");
//        properties.put("reasoning_steps",reasoning_steps);
//        properties.put("answer",answer);
//        schema.put("properties", properties);
//        JSONArray required = new JSONArray();
//        required.add("reasoning_steps");
//        required.add("answer");
//        schema.put("required",required);
//        schema.put("additionalProperties",false);
//
//        jsonSchema.put("schema", schema);
//        responseFormat.put("json_schema", jsonSchema);
//        json.put("response_format", responseFormat);
//
//        OkHttpClient client = new OkHttpClient()
//                .newBuilder()
//                .connectTimeout(120, TimeUnit.SECONDS)
//                .readTimeout(120, TimeUnit.SECONDS)
//                .writeTimeout(120, TimeUnit.SECONDS)
//                .hostnameVerifier(new AllowAllHostnameVerifier())
//                .build();
//        RequestBody body = RequestBody.create(MediaType.parse("application/json"), json.toJSONString());
//        Request request = new Request.Builder()
//                .url(gptBaseUrl)
//                .addHeader("Content-Type", "application/json")
//                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
//                .addHeader("Authorization", "Bearer " + gptApiKey)
//                .post(body)
//                .build();
//        //返回
//        try (Response response = client.newCall(request).execute()) {
//            if (response.isSuccessful()) {
//                ResponseBody responseBody = response.body();
//                if (responseBody != null) {
//                    StringBuilder builder = new StringBuilder();
//                    String line;
//                    BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
//                    while ((line = reader.readLine()) != null) {
//                        builder.append(line);
//                    }
//                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
//                    return jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
//                }
//            } else {
//                System.out.println("请求异常: " + response);
//            }
//        } catch (IOException e) {
//            e.printStackTrace();
//        }
//        return null;
//    }
}
