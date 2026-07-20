package com.sentum.evidencecomprehensive.utils.operateyl;

import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/12
 */
@Slf4j
public class AIHttpUtils {

    private static final Logger LOG = LoggerFactory.getLogger(AIHttpUtils.class);

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
    // 在类的开头定义一个静态Map来存储key的状态
    private static final Map<String, Integer> keyErrorCodes = new ConcurrentHashMap<>();
    
    public static Response okHttpStudio(RequestBody body, String model) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(60, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();

        int keyIndex = 0;
        int retryCount = 0;
//        int maxRetryCount = gpt_keys.size() * 2; // 增加最大重试次数，确保有足够的key可以轮询
        int maxRetryCount = 6;
        Response response = null;

        while (retryCount < maxRetryCount) {
            // 获取当前可用的key（跳过有错误状态的key）
            String currentKey = getCurrentAvailableKey(keyIndex);

            // 跳过特定有错误的key
            if (currentKey == null) {
                LOG.error("All keys have error status, unable to proceed");
                break;
            }
            
            Request request = new Request.Builder()
                    .url(LLM_BASE_URL)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                    .addHeader("Authorization", "Bearer " + currentKey)
                    .post(body)
                    .build();

            try {
                Date requestTime = new Date();
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    // 成功后清理该key的错误状态
                    keyErrorCodes.remove(currentKey);
                    LOG.info("模型调用成功 response code {}, 使用模型{}, current key {}, request请求调用完成时间{}", response.code(), model, currentKey, new Date().getTime() - requestTime.getTime());
                    return response;
                } else {
                    int code = response.code();
                    // 记录key对应的错误码
                    keyErrorCodes.put(currentKey, code);

                    LOG.error("模型调用失败 Request failed with current key: {}, status code: {}", currentKey, code);

                    if (isTransientError(code)) {
                        LOG.info("Key {} encountered transient error {}, will try next key", currentKey, code);
                        // 遇到特定错误码，继续下一次循环尝试下一个key
                        keyIndex++;
                        retryCount++;
                    } else {
                        // 非临时性错误，可能需要更慢的重试或者直接返回
                        LOG.error("Non-transient error {}, not suitable for immediate retry", code);
                        keyIndex++;
                        retryCount++;
                    }
                    
                    ResponseBody errorBody = response.body();
                    String errorBodyString = "No body";
                    if (errorBody != null) {
                        try {
                            errorBodyString = errorBody.string();  // 读取 body 内容
                        } catch (IOException e) {
                            errorBodyString = "Failed to read error body: " + e.getMessage();
                        }
                    }

                    LOG.error("Request failed with status code: {}, message: {}, response body: {}",
                            response.code(),
                            response.message(),
                            errorBodyString);
                    
                    // 显式关闭失败 Response 的 body，避免连接泄漏
                    if (response.body() != null) {
                        response.body().close();
                    }
                }
            } catch (IOException e) {
                LOG.error("IOException for key {}: {}", currentKey, e.getMessage(), e);
                // IO异常也记录key状态
                keyErrorCodes.put(currentKey, -1);
                if (response != null && response.body() != null) {
                    response.body().close();
                }
                keyIndex++;
                retryCount++;
            }

            try {
                Thread.sleep(600);
            } catch (InterruptedException e) {
                LOG.error(e.getMessage(), e);
            }
        }

        LOG.error("Maximum number of retries reached. Unable to complete the request.");
        return response;
    }
    /**
     * 获取当前可用的key，跳过有错误状态的key
     */
    private static String getCurrentAvailableKey(int startIndex) {
        for (int i = 0; i < gpt_keys.size(); i++) {
            int index = (startIndex + i) % gpt_keys.size();
            String key = gpt_keys.get(index);

            Integer errorCode = keyErrorCodes.get(key);
            if (errorCode == null || !isBlockError(errorCode)) {
                // 没有错误状态或不是阻止性错误，可以使用
                return key;
            }
        }
        // 如果所有key都处于错误状态，则返回第一个key（让调用方决定如何处理）
        return gpt_keys.get(startIndex % gpt_keys.size());
    }
    /**
     * 判断是否是临时性错误（可以跳过当前key尝试下一个的错误）
     */
    private static boolean isTransientError(int code) {
        // 429 - 请求过多，401 - 认证失败，403 - 禁止访问等都可以考虑跳过当前key
        return code == 429 || code == 401 || code == 403;
    }

    /**
     * 判断是否是阻止性错误（这些错误的key应该被暂时跳过）
     */
    private static boolean isBlockError(int code) {
        if (code == -1) return true; // IO异常
        return code == 429 || code == 401 || code == 403;
    }
    
    
    
    
    
    
    
    
    
    
    public static Response okHttpGpt(RequestBody body) {
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
