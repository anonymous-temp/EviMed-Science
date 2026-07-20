package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.dto.ai.GuideDS;
import com.sentum.evidencecomprehensive.service.DeepSeekService;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.commons.lang3.StringUtils;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;


/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/10
 */
@Slf4j
@Service
public class DeepSeekServiceImpl implements DeepSeekService {
    
//    private static final String URL = "https://api.siliconflow.com/v1/chat/completions";
//    private static final String TOKEN = System.getenv("EVIMED_LEGACY_LLM_API_KEY");

    // LLM base URL and model are env-overridable for local runs; defaults keep DashScope production behavior.
    private static final String URL = System.getenv().getOrDefault("EVIMED_LEGACY_LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    private static final String MODEL = System.getenv().getOrDefault("EVIMED_LEGACY_LLM_MODEL", "deepseek-v3");
    private static String token() {
        return requiredEnv("EVIMED_LEGACY_LLM_API_KEY");
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }
    
    @Override
    public List<GuideDS> searchGuideTop5(String drug, String disease) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .build();

        Map<Object, Object> req = new HashMap<>();
//        req.put("model", "deepseek-r1");
        req.put("model", MODEL);
        req.put("max_tokens", 4096);
        JSONArray message = new JSONArray();
        JSONObject m2 = new JSONObject();
        m2.put("content", "请帮忙查找几篇关于药物："+ drug +"，在病症"+ disease +"方面的几篇相关度较高的指南文章（如果多余 5 篇，按照相关度选取前 5 篇），" +
                "要求给出具体的指南标题title（需要显示指南的原标题，即语言跟随原标题显示，不要强制转成中文标题）、" +
                "总结内容content(可以显示重点章节内容 or 相关章节内容 or 关键内容 or 相关内容。需要确保内容准确反应\"+ drug +\"在\"+ disease +\"诊断中的应用。（内容请丰富一些，请使用中文回答章节内容）)、" +
                "作者author、" +
                "发布时间publish、" +
                "发布机构organ，" +
                "以及该篇指南所在的具体可以追溯的路径url。" +
                "\n" +
                "返回的格式如下：" +
                "\n" +
                "1、严格按照JSON格式返回所有内容。" +
                "\n" +
                "2、使用 result 数组接收内容。" +
                "\n" +
                "3、针对每一篇指南使用一个对象接收，格式如下：" +
                "{\"title\": ..., \" content\": ..., \" author\": ..., \" url\": ..., \"  publish\": ..., \" organ\": ...}");
        m2.put("role", "user");
        message.add(m2);
        req.put("messages", message);
        
//        JSONObject format = new JSONObject();
////        format.put("type", "json_object");
//        format.put("type", "text");
//        req.put("response_format", format);

        RequestBody body = RequestBody.create(MediaType.parse("application/json"), JSON.toJSONString(req));

        Request request = new Request.Builder()
                .url(URL)
                .addHeader("Content-Type", "application/json")
                .addHeader("Authorization", "Bearer " + token())
                .post(body)
                .build();
        //返回
        List<GuideDS> guideDSResult = new ArrayList<>();
        try (Response response = client.newCall(request).execute()) {
            if (response.isSuccessful()) {
                ResponseBody responseBody = response.body();
                if (responseBody != null) {
                    StringBuilder builder = new StringBuilder();
                    InputStream inputStream = responseBody.byteStream();
                    byte[] buffer = new byte[4096];
                    int bytesRead;
                    while ((bytesRead = inputStream.read(buffer)) != -1) {
                        builder.append(new String(buffer, 0, bytesRead));
                    }
                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
                    String resultResponse = jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                    if (StringUtils.isNotBlank(resultResponse)) {
                        try {
                            // tolerate markdown fences / prose wrappers around the JSON payload
                            String cleaned = resultResponse.replace("```json", "").replace("```", "");
                            int start = cleaned.indexOf('{');
                            int end = cleaned.lastIndexOf('}');
                            String substring = cleaned.substring(start, end + 1);
                            substring = wiffOfContent(substring, "“", "\"");
                            substring = wiffOfContent(substring, "”", "\"");
                            JSONObject obj = JSONObject.parseObject(substring);
                            JSONArray result = obj.getJSONArray("result");
                            result.forEach(o -> {
                                GuideDS guideDS = JSON.parseObject(JSON.toJSONString(o), GuideDS.class);
                                guideDSResult.add(guideDS);
                            });
                        } catch (Exception parseEx) {
                            log.error("指南结果解析失败,返回空结果。原始内容(截断): {}",
                                    resultResponse.substring(0, Math.min(500, resultResponse.length())), parseEx);
                        }
                    }
                }
            } else {
                log.error("请求异常:{} ", response);
            }
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
        return new ArrayList<>(guideDSResult);
    }
    
    
//    @Override
//    public List<GuideDS> searchGuideTop5(String drug, String disease) {
//        
//        OkHttpClient client = new OkHttpClient()
//                .newBuilder()
//                .connectTimeout(120, TimeUnit.SECONDS)
//                .readTimeout(240, TimeUnit.SECONDS)
//                .writeTimeout(120, TimeUnit.SECONDS)
//                .build();
//
//        Map<Object, Object> req = new HashMap<>();
////        JSONObject req = new JSONObject();
////        req.put("model", "Qwen/Qwen2.5-72B-Instruct");
//        req.put("model", "Pro/deepseek-ai/DeepSeek-R1");
////        req.put("model", "Pro/deepseek-ai/DeepSeek-V3");
//        req.put("max_tokens", 4096);
////        req.put("stream", false);
////        req.put("temperature", 0.7);
////        req.put("top_p", 0.7);
////        req.put("top_k", 50);
////        req.put("frequency_penalty", 0.5);
////        req.put("n", 1);
//
//        JSONArray message = new JSONArray();
//        JSONObject m1 = new JSONObject();
//        m1.put("role", "system");
//        m1.put("content", "You are a helpful assistant designed to output JSON.");
//        JSONObject m2 = new JSONObject();
//        m2.put("content", "请帮忙查找几篇关于药物："+ drug +"，在病症"+ disease +"方面的几篇相关度较高的指南文章（如果多余 5 篇，按照相关度选取前 5 篇），" +
//                "要求给出具体的指南标题title（需要显示指南的原标题，即语言跟随远标题显示，不要强制转成中文标题）、" +
//                "总结内容content(可以显示重点章节内容 or 相关章节内容 or 关键内容 or 相关内容。需要确保内容准确反应\"+ drug +\"在\"+ disease +\"诊断中的应用。（请使用中文回答章节内容）)、" +
//                "作者author、" +
//                "发布时间publish、" +
//                "发布机构organ，" +
//                "以及该篇指南所在的具体可以追溯的路径url。" +
//                "\n" +
//                "返回的格式如下：" +
//                "\n" +
//                "1、严格按照JSON格式返回所有内容。" +
//                "\n" +
//                "2、使用 result 数组接收内容。" +
//                "\n" +
//                "3、针对每一篇指南使用一个对象接收，格式如下：" +
//                "{\"title\": ..., \" content\": ..., \" author\": ..., \" url\": ..., \"  publish\": ..., \" organ\": ...}");
//        m2.put("role", "user");
//        message.add(m1);
//        message.add(m2);
//        req.put("messages", message);
//
////        JSONArray stop = new JSONArray();
////        stop.add("null");
////        req.put("stop", stop);
//
//        JSONObject format = new JSONObject();
////        format.put("type", "json_object");
//        format.put("type", "text");
//        req.put("response_format", format);
//
//        RequestBody body = RequestBody.create(MediaType.parse("application/json"), JSON.toJSONString(req));
//
//        Request request = new Request.Builder()
//                .url(URL)
//                .addHeader("Content-Type", "application/json")
//                .addHeader("Authorization", "Bearer " + TOKEN)
//                .post(body)
//                .build();
//        //返回
//        List<GuideDS> guideDSResult = new ArrayList<>();
//        try (Response response = client.newCall(request).execute()) {
//            if (response.isSuccessful()) {
//                ResponseBody responseBody = response.body();
//                if (responseBody != null) {
//                    StringBuilder builder = new StringBuilder();
//                    InputStream inputStream = responseBody.byteStream();
//                    byte[] buffer = new byte[4096];
//                    int bytesRead;
//                    while ((bytesRead = inputStream.read(buffer)) != -1) {
//                        builder.append(new String(buffer, 0, bytesRead));
//                    }
//                    JSONObject jsonObject = JSONObject.parseObject(builder.toString());
//                    String resultResponse = jsonObject.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
//                    if (StringUtils.isNotBlank(resultResponse)) {
//                        int start = resultResponse.indexOf('{');
//                        int end = resultResponse.lastIndexOf('}');
//                        String substring = resultResponse.substring(start, end + 1);
//                        substring = wiffOfContent(substring, "“", "\"");
//                        substring = wiffOfContent(substring, "”", "\"");
//                        JSONObject obj = JSONObject.parseObject(substring);
//                        JSONArray result = obj.getJSONArray("result");
//                        result.forEach(o -> {
//                            GuideDS guideDS = JSON.parseObject(JSON.toJSONString(o), GuideDS.class);
//                            guideDSResult.add(guideDS);
//                        });
//                    }
//                }
//            } else {
//                log.error("请求异常:{} ", response);
//            }
//        } catch (IOException e) {
//            log.error(e.getMessage(), e);
//        }
//        return new ArrayList<>(guideDSResult);
//    }

    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }
}
