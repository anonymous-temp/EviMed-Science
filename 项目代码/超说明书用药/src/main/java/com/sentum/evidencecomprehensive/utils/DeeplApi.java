package com.sentum.evidencecomprehensive.utils;

import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;

/**
 * deepl翻译 post请求
 */
@Slf4j
public class DeeplApi {
    private static final String DeepL_Auth_Key = "28850693-f4a3-4247-8e9b-6ea3088f3918:dp";
    private static final String TRANS_API_HOST = "https://api.deepl-pro.com/v2/translate";

    public static String trans(String text) {
        //判断之前去除其中的特殊符号
        String targetLang = "ZH";
        JSONObject params = new JSONObject();
        params.put("text", text);
        params.put("source_lang", "JA");
        params.put("target_lang", targetLang);
        try {
            HttpRequest post = HttpUtil.createPost(TRANS_API_HOST).setHostnameVerifier(new AllowAllHostnameVerifier());
            post.header("Authorization", DeepL_Auth_Key);
            post.body(params.toJSONString());
            HttpResponse execute = post.execute();
            String body = execute.body();
            JSONObject jsonObject = JSONObject.parseObject(body);
            JSONArray translations = jsonObject.getJSONArray("translations");
            String string = translations.getJSONObject(0).getString("text");
            //去除翻译结果中括号及括号中的内容
            string = string.replaceAll("\\(.*?\\)", "");
            return string;
        } catch (Exception e) {
            log.info("deepl翻译异常，重试一次！！！----{}", text);
            try {
                HttpRequest post = HttpUtil.createPost(TRANS_API_HOST);
                post.header("Authorization", DeepL_Auth_Key);
                post.body(params.toJSONString());
                HttpResponse execute = post.execute();
                String body = execute.body();
                JSONObject jsonObject = JSONObject.parseObject(body);
                JSONArray translations = jsonObject.getJSONArray("translations");
                String string = translations.getJSONObject(0).getString("text");
                //去除翻译结果中括号及括号中的内容
                string = string.replaceAll("\\(.*?\\)", "");
                return string;
            } catch (Exception ignored) {
            }
        }

        return "";
    }

}
