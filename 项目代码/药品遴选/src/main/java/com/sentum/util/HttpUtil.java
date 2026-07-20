package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sentum.service.LxGptService;
import org.apache.commons.lang3.StringUtils;
import org.apache.http.HttpEntity;
import org.apache.http.NameValuePair;
import org.apache.http.client.ClientProtocolException;
import org.apache.http.client.entity.UrlEncodedFormEntity;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.message.BasicNameValuePair;
import org.apache.http.util.EntityUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.net.ssl.*;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLEncoder;
import java.security.KeyManagementException;
import java.security.NoSuchAlgorithmException;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.Map.Entry;
import java.util.concurrent.TimeUnit;

@Component
public class HttpUtil {

    public static String subscriptionKey = "04775e6157ec486e9c521900ac7c88e4";
    public static String host = " https://api.bing.microsoft.com";
    public static String path = "/v7.0/search";

    public static String BIN_REDIS = "BIN:";
    @Autowired
    private LxGptService gptService;
    @Autowired
    private RedisTemplate redisTemplate;


    private static LxGptService gptServiceImpl;
    private static RedisTemplate redis;


    @PostConstruct
    public void getGpt() {
       gptServiceImpl = gptService;
       redis = redisTemplate;
    }
    
    /**
     * 单一问题类型   目前只是简单的搜索使用其中的 snippet 片段部分
     * @param searchQuery  搜索问题
     * @param type    问题类型 （规定搜索范围）
     */
    public static String SearchWebFromBing(String searchQuery, String type) throws Exception {
        String key = BIN_REDIS + searchQuery;
        if (redis.hasKey(key)) {
            redis.expire(key, 24, TimeUnit.HOURS);
            return (String) redis.opsForValue().get(key);
        }

//        URL url = new URL(host + path + "?q=" +  URLEncoder.encode(searchQuery, "UTF-8"));
//
//        HttpsURLConnection connection = (HttpsURLConnection)url.openConnection();
//        connection.setRequestProperty("Ocp-Apim-Subscription-Key", subscriptionKey);
//
//        // 跳过 SSL 证书验证
//        trustAllCertificates(connection);
//
//        // Receive the JSON response body.
//        InputStream stream = connection.getInputStream();
//        String response = new Scanner(stream).useDelimiter("\\A").next();
//
//        // Construct the result object.
//        SearchResults results = new SearchResults(new HashMap<>(), response);
//
//        // Extract Bing-related HTTP headers.
//        Map<String, List<String>> headers = connection.getHeaderFields();
//        for (String header : headers.keySet()) {
//            if (header == null) continue;      // may have null key
//            if (header.startsWith("BingAPIs-") || header.startsWith("X-MSEdge-")){
//                results.relevantHeaders.put(header, headers.get(header).get(0));
//            }
//        }
//        stream.close();
//
//        String prettify = prettify(results.jsonResponse);

        String gpt = gptServiceImpl.getGpt("作为医生小助手，请帮我查找" + searchQuery + "的相关的内容。###", "qwen3-235b-a22b-instruct-2507","");
        redis.opsForValue().set(key, gpt,24, TimeUnit.HOURS);
        return gpt;
    }

    private static void trustAllCertificates(HttpsURLConnection connection) throws NoSuchAlgorithmException, KeyManagementException {
        // 创建一个信任所有证书的 TrustManager
        TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
        };

        // 初始化一个 SSLContext
        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, trustAllCerts, new java.security.SecureRandom());

        // 创建一个 SSLSocketFactory
        SSLSocketFactory sslSocketFactory = sslContext.getSocketFactory();

        // 设置连接的 SSLSocketFactory
        connection.setSSLSocketFactory(sslSocketFactory);

        // 创建一个接受所有主机名的 HostnameVerifier
        HostnameVerifier allHostsValid = (hostname, session) -> true;

        // 设置连接的 HostnameVerifier
        connection.setHostnameVerifier(allHostsValid);
    }
    

    // pretty-printer for JSON; uses GSON parser to parse and re-serialize
    public static String prettify(String json_text) {
        List<String> searchDefinedRange = Collections.emptyList();
        StringBuilder resultBuilder = new StringBuilder();
        JsonParser parser = new JsonParser();
        JsonObject json = parser.parse(json_text).getAsJsonObject();
        JsonArray asJsonArray = json.getAsJsonObject("webPages").getAsJsonArray("value");
        for (JsonElement jsonElement : asJsonArray) {
            String snippet = jsonElement.getAsJsonObject().getAsJsonPrimitive("snippet").getAsString();

                resultBuilder.append(snippet);

        }
        
//        Gson gson = new GsonBuilder().setPrettyPrinting().create();
//        System.out.println(gson.toJson(json));
//        return gson.toJson(json);
        return resultBuilder.toString();
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

class SearchResults{
    HashMap<String, String> relevantHeaders;
    String jsonResponse;
    SearchResults(HashMap<String, String> headers, String json) {
        relevantHeaders = headers;
        jsonResponse = json;
    }
}
