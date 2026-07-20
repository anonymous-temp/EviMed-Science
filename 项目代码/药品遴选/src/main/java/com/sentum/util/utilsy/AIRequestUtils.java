package com.sentum.util.utilsy;

import cn.hutool.extra.spring.SpringUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.config.AIProviderConfig;
import com.sentum.constants.Constants;
import okhttp3.MediaType;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.apache.commons.collections4.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: AI请求工具（已重构支持多提供商）
 * DateTime: 2025/5/29
 */
public class AIRequestUtils {

    private static final Logger LOG = LoggerFactory.getLogger(AIRequestUtils.class);
    
    // Key轮询索引
    private static final AtomicInteger keyIndex = new AtomicInteger(0);

    /**
     * 【新】统一模型调用入口
     * 自动根据模型名推断提供商
     * @param question 问题
     * @param model 模型名称（如 deepseek-chat, qwen3-max-2025-09-23）
     * @return 模型返回内容
     */
    public static String modelStudio(String question, String model) {
        // 获取配置
        AIProviderConfig config = getConfig();
        
        // 确定使用的模型（如果为空则使用默认）
        String useModel = StringUtils.isNotBlank(model) ? model : config.getDefaultModel();
        
        // 根据模型推断提供商
        String provider = config.getProviderForModel(useModel);
        
        LOG.info("模型调用 - 模型: {}, 提供商: {}", useModel, provider);
        
        // 构建请求体
        JSONObject reqParam = buildRequestBody(question, useModel, null);
        
        // 获取API Key
        String apiKey = getApiKey(provider);
        
        // 执行调用
        MediaType mediaType = MediaType.get("application/json");
        try (Response response = AIHttpUtils.callLLM(
                RequestBody.create(mediaType, reqParam.toJSONString()), 
                provider, 
                apiKey)) {
            
            if (response.isSuccessful()) {
                return parseResponse(response, provider);
            } else {
                LOG.error("模型调用失败 - 模型: {}, 状态码: {}", useModel, response.code());
                return null;
            }
        }
    }

    /**
     * 构建请求体
     */
    private static JSONObject buildRequestBody(String question, String model, JSONObject options) {
        JSONObject reqParam = new JSONObject();
        reqParam.put("model", model);
        reqParam.put("stream", false);
        
        JSONArray messages = new JSONArray();
        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);
        reqParam.put("messages", messages);
        
        // 额外选项（如翻译配置）
        if (options != null) {
            reqParam.putAll(options);
        }
        
        return reqParam;
    }

    /**
     * 解析响应
     */
    private static String parseResponse(Response response, String provider) {
        try {
            ResponseBody responseBody = response.body();
            if (responseBody == null) {
                return null;
            }
            
            // 不同提供商可能有不同的响应格式
            if ("qwen".equals(provider)) {
                // 阿里云返回SSE流式格式（即使设置了stream=false）
                return parseSSEResponse(responseBody);
            } else {
                // DeepSeek、OpenAI返回标准JSON
                return parseStandardResponse(responseBody);
            }
        } catch (Exception e) {
            LOG.error("解析响应失败", e);
            return null;
        }
    }

    /**
     * 解析SSE流式响应（阿里云Qwen）
     */
    private static String parseSSEResponse(ResponseBody responseBody) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8))) {
            
            String line;
            while ((line = reader.readLine()) != null) {
                if (StringUtils.isBlank(line)) {
                    continue;
                }
                
                line = line.replaceAll("data: ", "");
                line = line.replaceAll("<｜end▁of▁sentence｜>", "");
                
                if ("[DONE]".equals(line)) {
                    break;
                }
                
                JSONArray choices = JSONObject.parseObject(line).getJSONArray("choices");
                if (CollectionUtils.isNotEmpty(choices)) {
                    String content = choices.getJSONObject(0)
                            .getJSONObject("message")
                            .getString("content");
                    if (StringUtils.isNotBlank(content)) {
                        return content;
                    }
                }
            }
        } catch (IOException e) {
            LOG.error("解析SSE响应失败", e);
        }
        return null;
    }

    /**
     * 解析标准JSON响应（DeepSeek、OpenAI）
     */
    private static String parseStandardResponse(ResponseBody responseBody) {
        try {
            String responseStr = responseBody.string();
            JSONObject responseJson = JSONObject.parseObject(responseStr);
            JSONArray choices = responseJson.getJSONArray("choices");
            
            if (CollectionUtils.isNotEmpty(choices)) {
                JSONObject firstChoice = choices.getJSONObject(0);
                JSONObject message = firstChoice.getJSONObject("message");
                String content = message.getString("content");
                
                if (StringUtils.isNotBlank(content)) {
                    return content;
                }
            }
        } catch (IOException e) {
            LOG.error("解析标准响应失败", e);
        }
        return null;
    }

    /**
     * 获取API Key（轮询）
     */
    private static String getApiKey(String provider) {
        AIProviderConfig config = getConfig();
        AIProviderConfig.ProviderInfo providerInfo = config.getProvider(provider);
        
        if (providerInfo == null || CollectionUtils.isEmpty(providerInfo.getApiKeys())) {
            throw new IllegalStateException("提供商 " + provider + " 没有配置API Key");
        }
        
        List<String> keys = providerInfo.getApiKeys();
        return keys.get(keyIndex.getAndIncrement() % keys.size());
    }

    /**
     * 获取配置
     */
    private static AIProviderConfig getConfig() {
        try {
            return SpringUtil.getBean(AIProviderConfig.class);
        } catch (Exception e) {
            LOG.warn("无法获取AIProviderConfig，使用默认配置");
            AIProviderConfig config = new AIProviderConfig();
            config.initDefaults();
            return config;
        }
    }

    // ==================== 以下为旧方法（保留兼容） ====================

    /**
     * 翻译调用
     */
    public static String modelStudioTrans(String question, String model, String transType) {
        JSONObject reqParam = new JSONObject();
        String useModel = StringUtils.isNotBlank(model) ? model : Constants.QWEN_MT_PLUS;
        reqParam.put("model", useModel);

        JSONArray messages = new JSONArray();
        reqParam.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);

        JSONObject translationOptions = new JSONObject();
        translationOptions.put("source_lang", "auto");
        translationOptions.put("target_lang", transType);
        reqParam.put("translation_options", translationOptions);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        try (Response response = AIHttpUtils.okHttpStudio(RequestBody.create(mediaType, reqParam.toJSONString()), model)) {
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用完成时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                String line;
                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                try  {
                    Date thinking = new Date();
                    while ((line = reader.readLine()) != null) {
                        if (StringUtils.isBlank(line)) {
                            continue;
                        }
                        line = line.replaceAll("data: ", "");
                        line = line.replaceAll("<｜end▁of▁sentence｜>", "");
                        if ("[DONE]".equals(line)) {
                            break;
                        }
                        JSONArray choices = JSONObject.parseObject(line).getJSONArray("choices");
                        if (CollectionUtils.isNotEmpty(choices)) {
                            String content = choices.getJSONObject(0).getJSONObject("message").getString("content");
                            if (StringUtils.isNotBlank(content)) {
                                return content;
                            }
                        }
                    }
                    LOG.info("模型{}, content 花费时间{}", useModel, new Date().getTime() - thinking.getTime());
                } catch (IOException e) {
                    LOG.error(e.getMessage(), e);
                }
            }
        }

        return null;
    }

    /**
     * ChatAnywhere调用（旧）
     */
    public static String chatAnyWhere(String question, String model) {
        JSONObject json = new JSONObject();
        AIProviderConfig config = getConfig();
        String useModel = StringUtils.isNotBlank(model) ? model : config.getDefaultModel();
        json.put("model", useModel);

        JSONArray messages = new JSONArray();
        json.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        try (Response response = AIHttpUtils.okHttpGpt(RequestBody.create(mediaType, json.toJSONString()))) {
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                String line;
                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                try  {
                    Date thinking = new Date();
                    while ((line = reader.readLine()) != null) {
                        if (StringUtils.isBlank(line)) {
                            continue;
                        }
                        line = line.replaceAll("data: ", "");
                        line = line.replaceAll("<｜end▁of▁sentence｜>", "");
                        if ("[DONE]".equals(line)) {
                            break;
                        }
                        JSONArray choices = JSONObject.parseObject(line).getJSONArray("choices");
                        if (CollectionUtils.isNotEmpty(choices)) {
                            String content = choices.getJSONObject(0).getJSONObject("message").getString("content");
                            if (StringUtils.isNotBlank(content)) {
                                return content;
                            }
                        }
                    }
                    LOG.info("模型{}, content 花费时间{}", useModel, new Date().getTime() - thinking.getTime());
                } catch (IOException e) {
                    LOG.error(e.getMessage(), e);
                }
            }
        }

        return null;
    }

    /**
     * GPT-4o流式调用（旧）
     */
    public static String gpt4oStream(String question, String model) {
        JSONObject json = new JSONObject();
        String useModel = "gpt-4o";
        if (StringUtils.isNotBlank(model)) {
            useModel = model;
        } 
        json.put("model", useModel);

        JSONArray messages = new JSONArray();
        json.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);

        json.put("stream", true);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        StringBuilder contentBuilder = new StringBuilder();
        try (Response response = AIHttpUtils.okHttpGpt(RequestBody.create(mediaType, json.toJSONString()))) {
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                String line;
                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                try  {
                    Date thinking = new Date();
                    while ((line = reader.readLine()) != null) {
                        if (StringUtils.isBlank(line)) {
                            continue;
                        }
                        line = line.replaceAll("data: ", "");
                        line = line.replaceAll("<｜end▁of▁sentence｜>", "");
                        if ("[DONE]".equals(line)) {
                            break;
                        }
                        JSONArray choices = JSONObject.parseObject(line).getJSONArray("choices");
                        if (CollectionUtils.isNotEmpty(choices)) {
                            String content = choices.getJSONObject(0).getJSONObject("delta").getString("content");
                            if (StringUtils.isNotBlank(content)) {
                                content = content.replaceAll("\n+", " ");
                                contentBuilder.append(content);
                            }
                        }                        
                    }
                    LOG.info("模型{}, content 花费时间{}", useModel, new Date().getTime() - thinking.getTime());
                } catch (IOException e) {
                    LOG.error(e.getMessage(), e);
                }
            }
        }

        return contentBuilder.toString();
    }

    /**
     * DeepSeek流式调用（旧）
     */
    public static String dsStream(String question, String model) {
        JSONObject json = new JSONObject();
        String useModel = "deepseek-v3";
        if (StringUtils.isNotBlank(model)) {
            useModel = model;
        }
        json.put("model", useModel);

        JSONArray messages = new JSONArray();
        json.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);

        json.put("stream", true);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        StringBuilder thinkBuilder = new StringBuilder();
        StringBuilder contentBuilder = new StringBuilder();
        try (Response response = AIHttpUtils.okHttpDeepSeek(RequestBody.create(mediaType, json.toJSONString()))) {
            if (response.isSuccessful()) {
                LOG.info("deepSeek-r1 request 请求调用时间{}", new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                String line;
                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                try  {
                    Date thinking = new Date();
                    while ((line = reader.readLine()) != null) {
                        if (StringUtils.isBlank(line)) {
                            continue;
                        }
                        line = line.replaceAll("data: ", "");
                        line = line.replaceAll("<｜end▁of▁sentence｜>", "");
                        if ("[DONE]".equals(line)) {
                            break;
                        }
                        String reasoningContent = "";
                        try {
                            reasoningContent = JSONObject.parseObject(line).getJSONArray("choices").getJSONObject(0).getJSONObject("delta").getString("reasoning_content");
                        } catch (Exception e) {
                            LOG.info(line);
                        }
                        String content = JSONObject.parseObject(line).getJSONArray("choices").getJSONObject(0).getJSONObject("delta").getString("content");
                        if (StringUtils.isNotBlank(reasoningContent)) {
                            reasoningContent = reasoningContent.replaceAll("\n+", " ");
                            thinkBuilder.append(reasoningContent);
                        }
                        if (StringUtils.isNotBlank(content)) {
                            content = content.replaceAll("\n+", " ");
                            contentBuilder.append(content);
                        }
                    }
                    LOG.info("thinking + content 花费时间{}", new Date().getTime() - thinking.getTime());
                } catch (IOException e) {
                    LOG.error(e.getMessage(), e);
                }
            }
        }

        return contentBuilder.toString();
    }

    /**
     * DeepSeek 非流式调用（旧）
     * @deprecated 使用 modelStudio() 替代
     */
    @Deprecated
    public static String dsNonStream(String question, String model) {
        JSONObject json = new JSONObject();
        String useModel = "deepseek-v3";
        if (StringUtils.isNotBlank(model)) {
            useModel = model;
        }
        json.put("model", useModel);
        json.put("stream", false);

        JSONArray messages = new JSONArray();
        json.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        try (Response response = AIHttpUtils.okHttpDeepSeek(RequestBody.create(mediaType, json.toJSONString()))) {
            if (response.isSuccessful()) {
                LOG.info("DeepSeek 模型 {}, request 请求调用时间: {}ms", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    String responseStr = responseBody.string();
                    LOG.info("DeepSeek 响应: {}", responseStr);

                    JSONObject responseJson = JSONObject.parseObject(responseStr);
                    JSONArray choices = responseJson.getJSONArray("choices");

                    if (CollectionUtils.isNotEmpty(choices)) {
                        JSONObject firstChoice = choices.getJSONObject(0);
                        JSONObject message = firstChoice.getJSONObject("message");

                        String content = message.getString("content");
                        if (StringUtils.isNotBlank(content)) {
                            LOG.info("DeepSeek 返回内容长度: {}", content.length());
                            return content;
                        }
                    }
                }
            } else {
                LOG.error("DeepSeek API 调用失败, HTTP 状态码: {}", response.code());
                if (response.body() != null) {
                    LOG.error("错误响应: {}", response.body().string());
                }
            }
        } catch (Exception e) {
            LOG.error("DeepSeek API 调用异常", e);
        }

        return null;
    }
}
