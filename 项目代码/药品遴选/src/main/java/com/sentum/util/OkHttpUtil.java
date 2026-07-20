package com.sentum.util;

import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 轮询gpt key值减轻服务压力
 * @author zgm
 */
@Slf4j
@Component
public class OkHttpUtil {
//    @Value("${deepseek.api_key}")
//    private String apiKey;
//    @Value("${deepseek.keys}")
//    private String deepseekKeys;
    private static Integer deepseekPollNum = 0;
    private static Integer pollNum = 0;
//    @Value("${gpt.keys}")
//    private String keyStr;
    @Value("${gpt.baseUrl}")
    private String baseUrl;

    @Value("${gpt.baseUrlBailian}")
    private String baseUrlBailian;

    // 静态的key列表
    private static final List<String> keys = new ArrayList<>();
    private static final List<String> bailianKeys = new ArrayList<>();
    // 静态索引变量
    private static int currentIndex = 0;
    private static int bailiancurrentIndex = 0;

    private static List<String> loadKeys(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return Arrays.asList(value.trim().split("\\s*,\\s*"));
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


    public static synchronized String getBailianNextKey() {
        if (bailianKeys.isEmpty()) {
            bailianKeys.addAll(loadKeys("DASHSCOPE_API_KEYS"));
        }
        // 使用索引获取当前key
        String currentKey = bailianKeys.get(bailiancurrentIndex);
        // 更新索引，使用取模操作确保索引在列表范围内
        bailiancurrentIndex = (bailiancurrentIndex + 1) % bailianKeys.size();
        return currentKey;
    }


    /**
     * 分部署结构，使用redis原子性控制key值
     */
    public Response response(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .cache(null)
                .build();
        //设置最大重试机制
        int maxRetries = 2;
        Response response = null;
        for (int i = 1; i <= maxRetries; i++) {
            try {
                String nextData = getNextKey();
                Request request = new Request.Builder()
                        .url(baseUrl)
                        .addHeader("Content-Type", "application/json")
                        .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                        .addHeader("Authorization", "Bearer " + nextData)
                        .post(body)
                        .build();
                log.info("gpt key rotation slot selected");
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    return response;
                } else {
                    log.error("gpt请求异常{}，开始重试。。。{}/{}", response, i, maxRetries);
                    try {

                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }
            } catch (IOException e) {
                log.error("gpt请求异常，开始重试。。。{}---{}", response, e);

                try {

                    String nextData = getNextKey();
                    Request request = new Request.Builder()
                            .url(baseUrl)
                            .addHeader("Content-Type", "application/json")
                            .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                            .addHeader("Authorization", "Bearer " + nextData)
                            .post(body)
                            .build();
                    log.info("gpt当前key值为{}--{}", nextData, nextData);
                    response = client.newCall(request).execute();
                    Thread.sleep(1000);
                    if (response.isSuccessful()) {
                        return response;
                    } else {
                        log.error("gpt请求异常{}，开始重试。。。{}/{}", response, i, maxRetries);
                        try {

                            Thread.sleep(1000);
                        } catch (InterruptedException ex) {
                            ex.printStackTrace();
                        }
                    }
                } catch (InterruptedException ex) {
                    ex.printStackTrace();
                } catch (IOException ex) {
                    throw new RuntimeException(ex);
                }
            }
        }
        log.error("gpt全部失败！！！");
        return response;
    }



    /**
     * 分部署结构，使用redis原子性控制key值
     */
    public Response responseBailian(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .cache(null)
                .build();
        //设置最大重试机制
        int maxRetries = 2;
        Response response = null;
        for (int i = 1; i <= maxRetries; i++) {
            try {
                String nextData = getBailianNextKey();
                Request request = new Request.Builder()
                        .url(baseUrlBailian)
                        .addHeader("Content-Type", "application/json")
                        .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                        .addHeader("Authorization", "Bearer " + nextData)
                        .post(body)
                        .build();
                log.info("gpt key rotation slot selected");
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    return response;
                } else {
                    log.error("gpt请求异常{}，开始重试。。。{}/{}", response, i, maxRetries);
                    try {

                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }
            } catch (IOException e) {
                log.error("gpt请求异常，开始重试。。。{}---{}", response, e);

                try {

                    String nextData = getBailianNextKey();
                    Request request = new Request.Builder()
                            .url(baseUrlBailian)
                            .addHeader("Content-Type", "application/json")
                            .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                            .addHeader("Authorization", "Bearer " + nextData)
                            .post(body)
                            .build();
                    log.info("gpt当前key值为{}--{}", nextData, nextData);
                    response = client.newCall(request).execute();
                    Thread.sleep(1000);
                    if (response.isSuccessful()) {
                        return response;
                    } else {
                        log.error("gpt请求异常{}，开始重试。。。{}/{}", response, i, maxRetries);
                        try {

                            Thread.sleep(1000);
                        } catch (InterruptedException ex) {
                            ex.printStackTrace();
                        }
                    }
                } catch (InterruptedException ex) {
                    ex.printStackTrace();
                } catch (IOException ex) {
                    throw new RuntimeException(ex);
                }
            }
        }
        log.error("gpt全部失败！！！请求为{}",body.toString());
        return response;
    }



    //单key版本
    public Response responseForDeepSeek_v1(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        Request request = new Request.Builder()
                .url("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " + getNextKey())
                .post(body)
                .build();
        //设置最大重试机制
        int maxRetries = 6;
        Response response = null;
        for (int i = 1; i <= maxRetries; i++) {
            try {
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    return response;
                } else {
                    log.error("请求异常{}，开始重试。。。{}/{}", response, i, maxRetries);
                }
            } catch (IOException e) {
                log.error("请求异常，开始重试。。。{}---{}", response, e);
            }
        }
        log.error("deepseek全部失败！！！");
        return response;
    }

    public Response responseForDeepSeek(RequestBody body) {
//        String[] keySplit = deepseekKeys.split(",");
//        int keySize = keySplit.length;
//        List<String> keys = new ArrayList<>(Arrays.asList(keySplit));
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        Request request = new Request.Builder()
                .url("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " + getNextKey())
                .post(body)
                .build();
        //设置最大重试机制
        int maxRetries = 6;
        Response response = null;
        for (int i = 1; i <= maxRetries; i++) {
            try {
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    deepseekPollNum++;
                    return response;
                } else {
                    deepseekPollNum++;
                }
            } catch (IOException e) {
                log.error("deepseek请求异常，开始重试。。。{}---{}", response, e);
                deepseekPollNum++;
            }
            //pollNum++;
        }
        log.error("deepseek全部失败！！！");
        return response;
    }
}
