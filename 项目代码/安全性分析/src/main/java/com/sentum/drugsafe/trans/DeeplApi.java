package com.sentum.drugsafe.trans;

import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.feign.FineScreenFeign;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.net.ssl.*;
import java.security.KeyManagementException;
import java.security.NoSuchAlgorithmException;
import java.security.cert.X509Certificate;

/**
 * deepl翻译 post请求
 */
@Slf4j
@Component
public class DeeplApi {
    private static final String DeepL_Auth_Key = "28850693-f4a3-4247-8e9b-6ea3088f3918:dp";
    private static final String TRANS_API_HOST = "https://api.deepl-pro.com/v2/translate";

    @Autowired
    private FineScreenFeign fineScreenFeign;

    public static String trans(String text) {
        //判断之前去除其中的特殊符号
        String targetLang = "ZH";
        JSONObject params = new JSONObject();
        params.put("text", text);
        params.put("source_lang", "JA");
        params.put("target_lang", targetLang);
        try {
            HttpRequest post = HttpUtil.createPost(TRANS_API_HOST)
                    .setHostnameVerifier((hostname, session) -> true)
                    .setSSLSocketFactory(createTrustAllSSLSocketFactory());
            post.header("Authorization", DeepL_Auth_Key);
            post.body(params.toJSONString());
            HttpResponse execute = post.execute();
            String body = execute.body();
            // 跳过 SSL 证书验证

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
        String transResult = TranslateWordUtil.translate(text );
        if (StringUtils.isNotBlank(transResult)) {
            return transResult;
        }
        return "";
    }


    private static SSLSocketFactory createTrustAllSSLSocketFactory() throws NoSuchAlgorithmException, KeyManagementException {
        TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() {
                        return null;
                    }

                    public void checkClientTrusted(X509Certificate[] certs, String authType) {
                    }

                    public void checkServerTrusted(X509Certificate[] certs, String authType) {
                    }
                }
        };

        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, trustAllCerts, new java.security.SecureRandom());
        return sslContext.getSocketFactory();
    }

}
