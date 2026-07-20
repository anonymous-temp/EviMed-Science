package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.map.MapUtil;
import com.fasterxml.jackson.core.type.TypeReference;
import com.sentum.evidencecomprehensive.utils.operateyl.JsonUtils;
import org.apache.commons.lang3.StringUtils;
import org.apache.http.HttpEntity;
import org.apache.http.HttpHeaders;
import org.apache.http.HttpStatus;
import org.apache.http.NameValuePair;
import org.apache.http.client.ClientProtocolException;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.entity.UrlEncodedFormEntity;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.utils.URIBuilder;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.message.BasicNameValuePair;
import org.apache.http.util.EntityUtils;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.Map.Entry;

public class HttpUtils {

    public static String subscriptionKey = "04775e6157ec486e9c521900ac7c88e4";
    public static String host = " https://api.bing.microsoft.com";
    public static String path = "/v7.0/search";

    public static final String APPLICATION_JSON = "application/json";

    private static final RequestConfig REQUEST_CONFIG = RequestConfig.custom()
            // 10分钟的响应时长
            .setSocketTimeout(900000)
            // 100秒 与被调用服务器建立连接时长
            .setConnectTimeout(10000)
            // 100秒 从连接池获取可用连接时长
            .setConnectionRequestTimeout(10000)
            .build();

    /**
     * Get请求传输json数据
     *
     * @param url  url地址
     * @param json json数据
     */
    public static String sendGetDataByJson(String url, String json) throws IOException, URISyntaxException {
        String result = "";
        try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
            URIBuilder uriBuilder = new URIBuilder(url);
            if (StringUtils.isNotBlank(json)) {
                HashMap<String, String> paramsMap = JsonUtils.toObj(json, new TypeReference<HashMap<String, String>>() {
                });
//                HashMap<String, String> paramsMap = JSONUtil.toBean(json, HashMap.class);
                if (MapUtil.isNotEmpty(paramsMap)) {
                    paramsMap.forEach(uriBuilder::addParameter);;
                }
            }

            HttpGet httpGet = new HttpGet(uriBuilder.build());
            httpGet.setHeader(HttpHeaders.CONTENT_TYPE, APPLICATION_JSON);
            httpGet.setConfig(REQUEST_CONFIG);
            // 执行请求
            try (CloseableHttpResponse response = httpClient.execute(httpGet);) {
                // 判断网络连接状态码是否正常(0--200都数正常)
                if (response.getStatusLine().getStatusCode() == HttpStatus.SC_OK) {
                    result = EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
                }
            }
        }
        return result;
    }


    
    public static String post(String url, Map<String, String> params, String charset)
            throws ClientProtocolException, IOException {
        String responseEntity = "";

        // 创建CloseableHttpClient对象
        CloseableHttpClient client = HttpClients.createDefault();

        // 创建post方式请求对象
        HttpPost httpPost = new HttpPost(url);

        // 生成请求参数
        List<NameValuePair> nameValuePairs = new ArrayList<>();
        if (params != null) {
            for (Entry<String, String> entry : params.entrySet()) {
                nameValuePairs.add(new BasicNameValuePair(entry.getKey(), entry.getValue()));
            }
        }

        // 将参数添加到post请求中
        httpPost.setEntity(new UrlEncodedFormEntity(nameValuePairs, charset));

        // 发送请求，获取结果（同步阻塞）
        CloseableHttpResponse response = client.execute(httpPost);

        // 获取响应实体
        HttpEntity entity = response.getEntity();
        if (entity != null) {
            // 按指定编码转换结果实体为String类型
            responseEntity = EntityUtils.toString(entity, charset);
        }

        // 释放资源
        EntityUtils.consume(entity);
        response.close();

        return responseEntity;
    }

}