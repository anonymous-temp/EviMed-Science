package com.sentum.util;


import cn.hutool.core.map.MapUtil;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;


import java.io.IOException;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Slf4j
public class HttpClientUtils {

    public static final OkHttpClient okHttpClient =  new OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS)
            .writeTimeout(3, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    private static final String CHARSET = "utf-8";

    /**
     * get 方式提交请求
     * @param url          请求的url
     * @param headerMap    请求头
     * @param parameterMap 请求参数
     */
    public static String get(String url, Map<String, String> headerMap, Map<String, String> parameterMap) {
        log.info("请求URL：{}", url);
        log.info("请求参数：{}", parameterMap);
        Request request = getRequest(url, headerMap, parameterMap);
        try {
            Response response = okHttpClient.newCall(request).execute();
            if (response.isSuccessful() && response.body() != null) {
                String result = response.body().string();
                return result;
            }else {
                String result = response.body().string();
                log.info("返回结果:{}", result);
            }
        } catch (IOException e) {
            log.error("请求异常", e);
            e.printStackTrace();
        }
        return null;
    }

    /**
     * 组装request
     * @param url          请求url
     * @param headerMap    请求头参数
     * @param parameterMap parameter参数
     */
    private static Request getRequest(String url, Map<String, String> headerMap, Map<String, String> parameterMap) {
        String completeUrl = getCompleteUrl(url, parameterMap);
        Request.Builder builder = new Request.Builder();
        if (MapUtil.isNotEmpty(headerMap)) {
            for (String key : headerMap.keySet()) {
                builder.addHeader(key, headerMap.get(key));
            }
        }
        return builder.url(completeUrl).build();
    }

    /**
     * 请求完整URL
     * @param url          请求url
     * @param parameterMap parameter参数
     */
    public static String getCompleteUrl(String url, Map<String, String> parameterMap) {
        if (MapUtil.isEmpty(parameterMap)) {
            return url;
        }
        StringBuilder stringBuilder = new StringBuilder(url).append("?");
        int index = 0;
        for (String key : parameterMap.keySet()) {
            if (index > 0) {
                stringBuilder.append("&");
            }
            stringBuilder.append(key).append("=").append(parameterMap.get(key));
            index++;
        }
        return stringBuilder.toString();
    }


    /**
     * post 方式发起请求
     * @param url        请求url
     * @param headerMap  请求头参数
     * @param jsonObject body参数
     */
    public static String doPostByHeaderAndBody(String url, Map<String, String> headerMap, String jsonObject) {
        log.info("请求url:{}", url);
        log.info("请求参数:{}", jsonObject);
        RequestBody requestBody = FormBody.create(MediaType.parse("application/json; charset=utf-8"), jsonObject);
        Request.Builder builder = new Request.Builder();
        if (MapUtil.isNotEmpty(headerMap)) {
            for (String key : headerMap.keySet()) {
                builder.addHeader(key, headerMap.get(key));
            }
        }
        Request request = builder.url(url).post(requestBody).build();
        try {
            Response response = okHttpClient.newCall(request).execute();
            if (response.isSuccessful() && response.body() != null) {
                String result = response.body().string();
                log.info("返回结果：{}", result);
                return result;
            }
        } catch (Exception e) {
            log.error("请求异常", e);
            e.printStackTrace();
        }
        return null;
    }


    /**
     * post方式提交json
     * @param url       请求的url
     * @param headerMap 请求头
     * @param parameter Json格式的数据
     */
    public static String postByJson(String url, Map<String, String> headerMap, String parameter) {
        log.info("url:{},headerMap:{},parameter:{}", url, headerMap, parameter);
        MediaType mediaType = MediaType.parse("application/json");
        RequestBody requestBody = RequestBody.create(mediaType, parameter);
        return post(url, headerMap, requestBody);
    }

    /**
     * @param url         请求url
     * @param headerMap   请求头
     * @param requestBody 请求体
     */
    private static String post(String url, Map<String, String> headerMap, RequestBody requestBody) {
        Request.Builder builder = new Request.Builder();
        if (MapUtil.isNotEmpty(headerMap)) {
            for (String key : headerMap.keySet()) {
                builder.addHeader(key, headerMap.get(key));
            }
        }
        Request request = builder.url(url).post(requestBody).build();
        try {
            Response response = okHttpClient.newCall(request).execute();
            if (response.isSuccessful() && response.body() != null) {
                String result = response.body().string();
                log.info("返回结果：{}", result);
                return result;
            }
        } catch (Exception e) {
            log.error("请求异常", e);
            e.printStackTrace();
        }
        return null;
    }
}
