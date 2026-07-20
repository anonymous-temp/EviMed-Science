package com.sentum.evidencecomprehensive.utils.operateyl;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import okhttp3.MediaType;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/5/29
 */
public class AIRequestUtils {

    private static final Logger LOG = LoggerFactory.getLogger(AIRequestUtils.class);

    public static String modelStudio(String question, String model) {

        JSONObject json = new JSONObject();
        String useModel = Constants.QWEN3_MAX_600_PRM;
        if (StringUtils.isNotBlank(model)) {
            useModel = model;
        }
        // EVIMED_LEGACY_LLM_MODEL takes precedence when set, so local runs can switch models without code changes.
        String envModel = System.getenv("EVIMED_LEGACY_LLM_MODEL");
        if (StringUtils.isNotBlank(envModel)) {
            useModel = envModel.trim();
        }
        json.put("model", useModel);

        JSONArray messages = new JSONArray();
        json.put("messages", messages);

        JSONObject userDataJson = new JSONObject();
        userDataJson.put("role", "user");
        userDataJson.put("content", question);
        messages.add(userDataJson);
        
        if (model.equals(Constants.QWEN_MT_PLUS)) {
            JSONObject translationOptions = new JSONObject();
            translationOptions.put("source_lang", "auto");
            translationOptions.put("target_lang", "Chinese");
            json.put("translation_options", translationOptions);
        }

        MediaType mediaType = MediaType.get("application/json");
        try (Response response = AIHttpUtils.okHttpStudio(RequestBody.create(mediaType, json.toJSONString()), model)) {
            // 处理响应
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                //引用文献完整匹配
                String line;
                BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody.byteStream(), StandardCharsets.UTF_8));
                try  {
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
                } catch (IOException e) {
                    LOG.error(e.getMessage(), e);
                }
            }
        }

        return null;
    }

    public static String modelStudioTrans(String question, String model, String transType) {

        JSONObject json = new JSONObject();
        String useModel = Constants.QWEN3_MAX_2025_09_23_60_PRM;
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

        JSONObject translationOptions = new JSONObject();
        translationOptions.put("source_lang", "auto");
        translationOptions.put("target_lang", transType);
        json.put("translation_options", translationOptions);

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        try (Response response = AIHttpUtils.okHttpStudio(RequestBody.create(mediaType, json.toJSONString()), model)) {
            // 处理响应
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用完成时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                //引用文献完整匹配
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

    public static String chatAnyWhere(String question, String model) {

        JSONObject json = new JSONObject();
        String useModel = Constants.QWEN3_MAX_2025_09_23_60_PRM;
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

        MediaType mediaType = MediaType.get("application/json");
        Date request = new Date();
        try (Response response = AIHttpUtils.okHttpGpt(RequestBody.create(mediaType, json.toJSONString()))) {
            // 处理响应
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                //引用文献完整匹配
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

    public static String gpt4oStream(String question, String model) {

        JSONObject json = new JSONObject();
//        String useModel = "gpt-4o-2024-08-06";
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
            // 处理响应
            if (response.isSuccessful()) {
                LOG.info("模型{}, request请求调用时间{}", useModel, new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                //引用文献完整匹配
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

    public static String dsStream(String question, String model) {

        JSONObject json = new JSONObject();
        String useModel = "deepseek-v3";
//        String useModel = "deepseek-r1-0528";
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
            // 处理响应
            if (response.isSuccessful()) {
                LOG.info("deepSeek-r1 request 请求调用时间{}", new Date().getTime() - request.getTime());
                ResponseBody responseBody = response.body();
                assert responseBody != null;
                //引用文献完整匹配
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
}
