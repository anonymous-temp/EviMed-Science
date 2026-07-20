package com.sentum.evidencecomprehensive.utils.operateyl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import com.fasterxml.jackson.core.type.TypeReference;
import com.google.gson.*;
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
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.message.BasicNameValuePair;
import org.apache.http.util.EntityUtils;

import javax.net.ssl.*;
import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyManagementException;
import java.security.NoSuchAlgorithmException;
import java.security.cert.X509Certificate;
import java.util.*;

/**
 * @Description: http 请求工具类
 */

public class HttpClientUtils {
    
    public static final String APPLICATION_JSON = "application/json";
    
    private static final RequestConfig REQUEST_CONFIG = RequestConfig.custom()
            // 10分钟的响应时长
            .setSocketTimeout(900000)
            // 100秒 与被调用服务器建立连接时长
            .setConnectTimeout(10000)
            // 100秒 从连接池获取可用连接时长
            .setConnectionRequestTimeout(10000)
            .build();
    

    public static String post(String url, Map<String, String> params, String charset) throws IOException {
        String responseEntity = "";

        // 创建CloseableHttpClient对象
        CloseableHttpClient client = HttpClients.createDefault();

        // 创建post方式请求对象
        HttpPost httpPost = new HttpPost(url);

        // 生成请求参数
        List<NameValuePair> nameValuePairs = new ArrayList<>();
        if (params != null) {
            for (Map.Entry<String, String> entry : params.entrySet()) {
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

    /**
     * Post请求传输json数据
     *
     * @param url  url地址
     * @param json json数据
     * @return
     * @throws ClientProtocolException
     * @throws IOException
     */
    public static String sendPostDataByJson(String url, String json) throws ClientProtocolException, IOException {
        String result = "";

        // 创建httpclient对象
        try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
            // 创建post方式请求对象
            HttpPost httpPost = new HttpPost(url);
            httpPost.setHeader(HttpHeaders.CONTENT_TYPE, APPLICATION_JSON);
            // 设置参数到请求对象中
            StringEntity stringEntity = new StringEntity(json, StandardCharsets.UTF_8);
            httpPost.setEntity(stringEntity);

            // 执行请求操作，并拿到结果（同步阻塞）
            try (CloseableHttpResponse response = httpClient.execute(httpPost)) {
                // 获取结果实体
                // 判断网络连接状态码是否正常(0--200都数正常)
                if (response.getStatusLine().getStatusCode() == HttpStatus.SC_OK) {
                    result = EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
                }
            }
        }
        return result;
    }


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
            if (StrUtil.isNotBlank(json)) {
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
}