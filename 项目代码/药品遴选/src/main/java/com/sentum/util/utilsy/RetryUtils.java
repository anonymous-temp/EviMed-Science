package com.sentum.util.utilsy;

import cn.hutool.extra.spring.SpringUtil;
import com.google.gson.Gson;
import com.sentum.config.AIProviderConfig;
import com.sentum.infrastructure.config.ParameterizedRetryCallback;
import com.sentum.constants.Constants;
import com.sentum.enums.GptDemoEnum;
import com.sentum.exception.RateLimitException;
import com.sentum.infrastructure.handler.ModelRateLimiter;
import com.sentum.infrastructure.handler.PriorityKeyBasedRateLimiter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.retry.RetryCallback;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.stereotype.Component;

import java.lang.reflect.Type;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Date;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/31
 */
@Component
public class RetryUtils {

    private static final Logger LOG = LoggerFactory.getLogger(RetryUtils.class);

    @Autowired
    private PriorityKeyBasedRateLimiter rateLimiter;
    @Autowired
    private ModelRateLimiter modelRateLimiter;
    @Autowired
    private AIProviderConfig aiProviderConfig;

    // 默认优先级
    private static final int DEFAULT_PRIORITY = 50;
    private static final int maxNullRetryAttempts = 4;  // 最大空结果重试次数
    private static final long nullRetryWaitTime = 1000; // 重试等待时间(毫秒)
    private static final long futureTimeout = 60;       // Future等待超时时间(秒)
    private static final long taskTimeout = 120;

    public <T> T executeWithRetryNew(String prompt, String modelType, Type typeToken,
                                  String tips, int priority, boolean useQueueDelay) {
        T result = null;
        int attempts = 0;
        long startTime = LocalDateTime.now().atZone(ZoneId.of("Asia/Shanghai")).toEpochSecond();

        while (attempts < maxNullRetryAttempts + 1) { // +1 包含第一次尝试
            try {
                LOG.info("开始执行 - 模型: {}, priority: {}, tips: {}, 请求次数: {}", modelType, priority, tips, attempts + 1);

                // 将任务提交到优先级队列
                CompletableFuture<T> future = modelRateLimiter.submitTask(prompt, modelType, typeToken, tips, priority, useQueueDelay);

                // 等待结果 - 使用配置的超时时间
                long remainingTime = Math.max(1, taskTimeout - (Instant.now().getEpochSecond() - startTime));
                result = future.get(Math.max(futureTimeout, remainingTime), TimeUnit.SECONDS);
//                result = future.get(futureTimeout, TimeUnit.SECONDS);

                // 检查结果是否为null
                if (result != null) {
                    long endTime = LocalDateTime.now().atZone(ZoneId.of("Asia/Shanghai")).toEpochSecond();
                    LOG.info("执行完毕 - 模型: {}, priority: {}, tips: {}, 请求次数: {}, 用时：{}", modelType, priority, tips, attempts + 1, Instant.now().getEpochSecond() - startTime);
                    return result;
                } else {
                    LOG.info("执行失败 - 模型: {}, tips: {}, 请求次数: {}", modelType, tips, attempts + 1);
                }
            } catch (TimeoutException e) {
                LOG.warn("任务执行超时 - 提示: {}, 尝试次数: {}, 错误: {}", tips, attempts + 1, e.getMessage(), e);
            } catch (ExecutionException e) {
                LOG.error("任务执行异常 - 提示: {}, 尝试次数: {}, 错误: {}", tips, attempts + 1, e.getCause().getMessage(), e.getCause());
                // 如果是执行异常，也计入null重试次数
            } catch (InterruptedException e) {
                LOG.error("任务执行被中断 - 提示: {}, 错误: {}", tips, e.getMessage(), e);
                Thread.currentThread().interrupt();
                throw new RuntimeException("任务执行被中断: " + e.getMessage(), e);
            }

            attempts++;

            // 如果还有重试机会，等待一段时间后重试
            if (attempts <= maxNullRetryAttempts) {
                try {
                    Thread.sleep(nullRetryWaitTime);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("重试等待被中断", e);
                }
            }
        }
        // 所有重试都失败了
        String errorMsg = String.format("请求调用失败，重试次数已用完 after %d attempts (including %d null retries) - 提示: %s", attempts, maxNullRetryAttempts, tips);
        LOG.error(errorMsg);
        return null;
    }

    @SuppressWarnings("unchecked")
    public <T> T executeWithRetry(String prompt, Type typeToken, String tips, int priority, String limitJsonField) {
        // ✅ 使用 tips 作为任务名从配置文件获取模型
        String modelType = null;
        if (aiProviderConfig != null) {
            modelType = aiProviderConfig.getModelForTask(tips);
            LOG.info("使用任务配置模型 - task: {}, model: {}", tips, modelType);
        }

        final String finalModel = modelType;

        // ✅ 每次调用都创建新的 RetryTemplate，避免并发问题
        RetryTemplate retryTemplate = SpringUtil.getBean("aiRetryTemplate", RetryTemplate.class);

        // 将获取令牌和执行业务逻辑都放在重试模板中
        RetryCallback<T, Throwable> callback = context -> {

            long startTime = LocalDateTime.now().atZone(ZoneId.of("Asia/Shanghai")).toEpochSecond();
            LOG.info("开始执行 - key: {}, priority: {}, tips: {}, attempt: {}, startTime：{}",
                    finalModel, priority, tips, context.getRetryCount() + 1, startTime);

            // 获取令牌
            if (!rateLimiter.tryAcquire(finalModel, priority, 5, TimeUnit.SECONDS)) {
                LOG.warn("请求被限流 - key: {}, priority: {}, tips: {}, attempt: {}",
                        finalModel, priority, tips, context.getRetryCount() + 1);
                throw new RateLimitException("请求过于频繁，请稍后重试");
            }


            // 执行业务逻辑
            String summaryResult = AIRequestUtils.modelStudio(prompt, finalModel);

            if (typeToken.equals(String.class)) {
                return (T) summaryResult;
            }

            if (typeToken.equals(Double.class)) {
                return (T) summaryResult;
            }

            assert summaryResult != null;
            int start = summaryResult.indexOf('{');
            int end = summaryResult.lastIndexOf('}');
            if (start == -1 || end == -1) {
                throw new IllegalArgumentException("Invalid JSON format");
            }

            try {
                summaryResult = summaryResult.substring(start, end + 1);

                long endTime = LocalDateTime.now().atZone(ZoneId.of("Asia/Shanghai")).toEpochSecond();

                LOG.info("执行完毕 - key: {}, priority: {}, tips: {}, attempt: {}, endTime：{}, 用时：{}",
                        finalModel, priority, tips, context.getRetryCount() + 1, endTime, endTime - startTime);
                Gson gson = new Gson();
                return gson.fromJson(summaryResult, typeToken);
            } catch (Exception e) {
                LOG.error("GSON 数据格式转换错误 {}", e.getMessage(), e);
                throw new RuntimeException(e);
            }
        };

        try {
            return retryTemplate.execute(callback);
        } catch (Throwable e) {
            LOG.error("执行最终失败 - tips: {}, error: {}", tips, e.getMessage(), e);
            throw new RuntimeException(e);
        }
    }

    public static String executeTransWithRetry(String word, String transType, String tips) {
        RetryTemplate retryTemplate = SpringUtil.getBean(RetryTemplate.class);

        String  modelType = Constants.QWEN_MT_PLUS;
        RetryCallback<String, Throwable> actualCallback = context -> AIRequestUtils.modelStudioTrans(word, modelType, transType);

        ParameterizedRetryCallback<String> parametrizedCallback =
                new ParameterizedRetryCallback<>(word, modelType, String.class, tips, actualCallback);

        try {
            return retryTemplate.execute(parametrizedCallback);
        } catch (Throwable e) {
            LOG.error(e.getMessage(), e);
            throw new RuntimeException(e);
        }
    }

    /**
     * 通用重试方法
     * @param <T> 返回结果类型
     * @param task 需要执行的任务，用Supplier封装（无参有返回）
     * @param maxRetries 最大重试次数
     * @param retryInterval 重试间隔毫秒数
     * @param retryOn 用于判断异常是否需要重试，如果返回true则重试，否则抛出异常
     * @return 任务执行返回结果
     * @throws Exception 最终重试失败抛出的异常
     */
    public static <T> T retry(Supplier<T> task, int maxRetries, long retryInterval, Predicate<Exception> retryOn) throws Exception {
        int attempt = 0;
        Exception lastException = null;

        while (attempt < maxRetries) {
            try {
                return task.get();  // 执行任务
            } catch (Exception e) {
                lastException = e;
                attempt++;
                if (!retryOn.test(e) || attempt >= maxRetries) {
                    break;
                }
                try {
                    Thread.sleep(retryInterval);
                } catch (InterruptedException ie) {
                    // 处理中断异常，一般中断时可以退出循环
                    Thread.currentThread().interrupt();
                    throw ie;
                }
            }
        }
        throw lastException;
    }

}
