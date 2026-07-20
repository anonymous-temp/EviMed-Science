package com.sentum.evidencecomprehensive.utils.operateyl;

import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/12
 */
@Slf4j
public class AIHttpUtils {

    private static final String deepSeek_key = requiredEnv("DEEPSEEK_API_KEY");
    
    private static final List<String> gpt_keys = loadKeys("EVIMED_LEGACY_LLM_API_KEYS");

    // Base URL of the OpenAI-compatible LLM endpoint; EVIMED_LEGACY_LLM_BASE_URL overrides it for local runs, default keeps DashScope.
    private static final String LLM_BASE_URL = System.getenv().getOrDefault("EVIMED_LEGACY_LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");

    private static List<String> loadKeys(String name) {
        return Arrays.asList(requiredEnv(name).split("\\s*,\\s*"));
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }

    // 使用 AtomicInteger 来确保线程安全的自增操作
    private static final AtomicInteger currentKeyIndex = new AtomicInteger(0);

    public static Response okHttpStudio(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(60, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();

        int retryCount = 0;
        int maxRetryCount = 6;
        Response response = null;

        while (retryCount < maxRetryCount) {
            // 每次请求更新当前使用的 key 的索引，并选择对应的 key
            String currentKey = gpt_keys.get(currentKeyIndex.getAndIncrement() % gpt_keys.size());
            Request request = new Request.Builder()
                    .url(LLM_BASE_URL)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                    .addHeader("Authorization", "Bearer " + currentKey)
                    .post(body)
                    .build();

            try {
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    return response;
                } else {
                    log.error("Request failed with status code: {}", response.code());
                    // 显式关闭失败 Response 的 body，避免连接泄漏
                    if (response.body() != null) {
                        response.body().close();
                    }
                }
            } catch (IOException e) {
                log.error(e.getMessage(), e);
                if (response != null && response.body() != null) {
                    response.body().close(); // 异常情况下关闭已获取的 Response body
                }
            }

            retryCount++;
        }

        log.error("Maximum number of retries reached. Unable to complete the request.");
        return response;
    }
    
    public static Response okHttpGpt(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();

        int retryCount = 0;
        int maxRetryCount = 6;
        Response response = null;

        while (retryCount < maxRetryCount) {
            // 每次请求更新当前使用的 key 的索引，并选择对应的 key
            String currentKey = gpt_keys.get(currentKeyIndex.getAndIncrement() % gpt_keys.size());
            Request request = new Request.Builder()
                    .url("https://api.chatanywhere.tech/v1/chat/completions")
                    .addHeader("Content-Type", "application/json")
                    .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                    .addHeader("Authorization", "Bearer " + currentKey)
                    .post(body)
                    .build();

            try {
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    return response;
                } else {
                    log.error("Request failed with status code: {}", response.code());
                    // 显式关闭失败 Response 的 body，避免连接泄漏
                    if (response.body() != null) {
                        response.body().close();
                    }
                }
            } catch (IOException e) {
                log.error(e.getMessage(), e);
                if (response != null && response.body() != null) {
                    response.body().close(); // 异常情况下关闭已获取的 Response body
                }
            }

            retryCount++;
        }

        log.error("Maximum number of retries reached. Unable to complete the request.");
        return response;
    }

    public static Response okHttpDeepSeek(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        Request request = new Request.Builder()
                .url(LLM_BASE_URL)
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " + deepSeek_key)
                .post(body)
                .build();
        Response response = null;
        try {
            response = client.newCall(request).execute();
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }

        return response;
    }
}
