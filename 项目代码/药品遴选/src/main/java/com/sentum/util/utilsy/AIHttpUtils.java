package com.sentum.util.utilsy;

import cn.hutool.extra.spring.SpringUtil;
import com.sentum.config.AIProviderConfig;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.apache.http.conn.ssl.AllowAllHostnameVerifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 统一AI HTTP调用工具（已重构支持多提供商）
 * DateTime: 2025/3/12
 */
@Slf4j
public class AIHttpUtils {
    
    private static final Logger LOG = LoggerFactory.getLogger(AIHttpUtils.class);

    // 保留旧的Key配置（向后兼容）
    private static final String deepSeek_key = requiredEnv("DEEPSEEK_API_KEY");

    private static final List<String> gpt_keys = loadKeys("EVIMED_LEGACY_LLM_API_KEYS");

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

    /**
     * 【新】统一LLM HTTP调用入口
     * @param body 请求体
     * @param provider 提供商名称（deepseek/qwen/openai）
     * @param apiKey API密钥
     * @return Response
     */
    public static Response callLLM(RequestBody body, String provider, String apiKey) {
        AIProviderConfig config = getConfig();
        AIProviderConfig.ProviderInfo providerInfo = config.getProvider(provider);
        
        if (providerInfo == null) {
            LOG.error("未找到提供商配置: {}", provider);
            throw new IllegalArgumentException("未找到提供商配置: " + provider);
        }
        
        String url = providerInfo.getUrl();
        AIProviderConfig.TimeoutConfig timeout = config.getTimeout();
        
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(timeout.getConnect(), TimeUnit.SECONDS)
                .readTimeout(timeout.getRead(), TimeUnit.SECONDS)
                .writeTimeout(timeout.getWrite(), TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        
        Request request = new Request.Builder()
                .url(url)
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                .addHeader("Authorization", "Bearer " + apiKey)
                .post(body)
                .build();
        
        Response response = null;
        try {
            Date startTime = new Date();
            response = client.newCall(request).execute();
            
            if (response.isSuccessful()) {
                LOG.info("LLM调用成功 - 提供商: {}, 耗时: {}ms", provider, new Date().getTime() - startTime.getTime());
            } else {
                LOG.error("LLM调用失败 - 提供商: {}, HTTP状态码: {}", provider, response.code());
            }
            
            return response;
        } catch (IOException e) {
            LOG.error("LLM调用异常 - 提供商: {}", provider, e);
            if (response != null && response.body() != null) {
                response.body().close();
            }
            throw new RuntimeException("LLM调用异常: " + e.getMessage(), e);
        }
    }
    
    /**
     * 获取配置（懒加载）
     */
    private static AIProviderConfig getConfig() {
        try {
            return SpringUtil.getBean(AIProviderConfig.class);
        } catch (Exception e) {
            LOG.warn("无法获取AIProviderConfig，使用默认配置");
            AIProviderConfig config = new AIProviderConfig();
            config.initDefaults();
            return config;
        }
    }

    /**
     * 【旧】阿里平台调用（保留兼容）
     * @deprecated 推荐使用 callLLM()
     */
    @Deprecated
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
        int maxRetryCount = 6;
        Response response = null;

        while (retryCount < maxRetryCount) {
            String currentKey = getCurrentAvailableKey(keyIndex);

            if (currentKey == null) {
                LOG.error("模型调用所有key 都已不可用");
                break;
            }

            Request request = new Request.Builder()
                    .url("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
                    .addHeader("Content-Type", "application/json")
                    .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
                    .addHeader("Authorization", "Bearer " + currentKey)
                    .post(body)
                    .build();

            try {
                Date requestTime = new Date();
                response = client.newCall(request).execute();
                if (response.isSuccessful()) {
                    keyErrorCodes.remove(currentKey);
                    LOG.info("模型调用成功 response code {}, 使用模型{}, current key {}, request请求调用完成时间{}", response.code(), model, currentKey, new Date().getTime() - requestTime.getTime());
                    return response;
                } else {
                    int code = response.code();
                    keyErrorCodes.put(currentKey, code);
                    LOG.error("模型调用失败 status code: {}, 使用模型{}, current key: {}", code, model, currentKey);

                    if (isTransientError(code)) {
                        keyIndex++;
                        retryCount++;
                    } else {
                        keyIndex++;
                        retryCount++;
                    }

                    ResponseBody errorBody = response.body();
                    String errorBodyString = "No body";
                    if (errorBody != null) {
                        try {
                            errorBodyString = errorBody.string();
                        } catch (IOException e) {
                            errorBodyString = "Failed to read error body: " + e.getMessage();
                        }
                    }

                    LOG.error("模型调用错误信息 Request failed with status code: {}, message: {}, response body: {}",
                            response.code(),
                            response.message(),
                            errorBodyString);

                    if (response.body() != null) {
                        response.body().close();
                    }
                }
            } catch (IOException e) {
                LOG.error("IOException for key {}: {}", currentKey, e.getMessage(), e);
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

        LOG.error("模型调用超出最大请求次数");
        return response;
    }

    private static String getCurrentAvailableKey(int startIndex) {
        for (int i = 0; i < gpt_keys.size(); i++) {
            int index = (startIndex + i) % gpt_keys.size();
            String key = gpt_keys.get(index);

            Integer errorCode = keyErrorCodes.get(key);
            if (errorCode == null || !isBlockError(errorCode)) {
                return key;
            }
        }
        return gpt_keys.get(startIndex % gpt_keys.size());
    }
    
    private static boolean isTransientError(int code) {
        return code == 429 || code == 401 || code == 403;
    }

    private static boolean isBlockError(int code) {
        if (code == -1) return true;
        return code == 429 || code == 401 || code == 403;
    }
    
    @Deprecated
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
                    if (response.body() != null) {
                        response.body().close();
                    }
                }
            } catch (IOException e) {
                log.error(e.getMessage(), e);
                if (response != null && response.body() != null) {
                    response.body().close();
                }
            }

            retryCount++;
        }

        log.error("Maximum number of retries reached");
        return response;
    }

    @Deprecated
    public static Response okHttpDeepSeek(RequestBody body) {
        OkHttpClient client = new OkHttpClient()
                .newBuilder()
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(240, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS)
                .hostnameVerifier(new AllowAllHostnameVerifier())
                .build();
        Request request = new Request.Builder()
                .url("https://api.deepseek.com/v1/chat/completions")
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
