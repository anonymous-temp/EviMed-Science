package com.sentum.evidencecomprehensive.service.handler;

import cn.hutool.extra.spring.SpringUtil;
import com.google.gson.Gson;
import com.sentum.evidencecomprehensive.pojo.bo.other.PriorityTask;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.retry.RetryCallback;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;
import java.lang.reflect.Type;
import java.util.*;
import java.util.concurrent.*;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 限流器
 * DateTime: 2025/9/18
 */

@Component
public class PriorityKeyBasedRateLimiter {
    
    private static final Logger LOG = LoggerFactory.getLogger(PriorityKeyBasedRateLimiter.class);

    // 每个模型类型对应一个优先级队列
    private final Map<String, PriorityBlockingQueue<PriorityTask>> modelQueueMap = new ConcurrentHashMap<>();

    // 每个模型的执行器线程池
    private final Map<String, ScheduledExecutorService> executorServiceMap = new ConcurrentHashMap<>();

    // 每秒执行请求数的配置（毫秒间隔）
    private volatile long requestInterval = 300; 

    // 用于立即执行的线程池
//    private final ExecutorService immediateExecutor = Executors.newCachedThreadPool(
//            r -> new Thread(r, "ImmediateAIExecutor"));
    // 在类初始化时创建
    private ExecutorService immediateExecutor;

    @PostConstruct
    public void initImmediateExecutor() {
        this.immediateExecutor = new ThreadPoolExecutor(
                5,           // 核心线程数
                5,           // 最大线程数
                60L,                           // 空闲线程存活时间
                TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(200), // 队列容量
                r -> new Thread(r, "ImmediateAIExecutor-" + r.hashCode()),
                new ThreadPoolExecutor.CallerRunsPolicy() // 拒绝策略：调用者线程执行
        );
    }
    
    @PostConstruct
    public void init() {
        LOG.info("PriorityKeyBasedRateLimiter 初始化完成");
    }

    /**
     * 添加任务到队列
     */
    public <T> CompletableFuture<T> submitTask(String prompt, String modelType, Type typeToken, String tips, int priority, boolean useQueueDelay) {
        if (useQueueDelay) {
            PriorityTask task = new PriorityTask(prompt, modelType, typeToken, tips, priority);

            // 获取或创建队列
            PriorityBlockingQueue<PriorityTask> queue = modelQueueMap.computeIfAbsent(modelType, k -> new PriorityBlockingQueue<>(1000, new PriorityTaskComparator()));

            // 添加到队列
            queue.offer(task);

            // 获取或创建执行器
            ScheduledExecutorService executor = executorServiceMap.computeIfAbsent(modelType, k -> createExecutorService(modelType));

            // 返回任务本身携带的Future
            // 这个Future会在 processNextTask 中被完成
            return (CompletableFuture<T>) task.getFuture();
        } else {
            // 立即执行模式
            CompletableFuture<T> future = new CompletableFuture<>();

            // 在新线程中立即执行，不等待队列
            immediateExecutor.submit(() -> {
                try {
                    LOG.info("立即执行AI请求 - 模型: {}, 提示: {}, 优先级: {}", modelType, tips, priority);

                    // 直接执行AI请求，包含重试逻辑
                    Object o = executeAiRequestWithRetry(prompt, modelType, typeToken, tips);

                    LOG.info("立即执行完成 - 模型: {}, 提示: {}, 优先级: {}", modelType, tips, priority);

                    future.complete((T) o);

                } catch (Exception e) {
                    LOG.error("立即执行失败 - 模型: {}, 提示: {}, 错误: {}", modelType, tips, e.getMessage(), e);
                    future.completeExceptionally(e);
                }
            });

            return future;
        }
       
    }

    /**
     * 创建执行器服务
     */
    private ScheduledExecutorService createExecutorService(String modelType) {
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "PriorityRateLimiter-" + modelType));

        // 启动定期任务，每requestInterval毫秒执行一次
        executor.scheduleAtFixedRate(() -> processNextTask(modelType), 0, requestInterval, TimeUnit.MILLISECONDS);

        LOG.info("为模型 {} 创建执行器，请求间隔: {}ms", modelType, requestInterval);
        return executor;
    }

    /**
     * 处理下一个任务
     */
    private void processNextTask(String modelType) {
        PriorityBlockingQueue<PriorityTask> queue = modelQueueMap.get(modelType);
        if (queue == null || queue.isEmpty()) {
            return;
        }

        PriorityTask task = queue.poll();
        if (task != null) {
//            LOG.info("执行任务 - 模型: {}, 优先级: {}, 提示: {}", task.getModelType(), task.getPriority(), task.getTips());

            // 执行AI请求并获取结果
            RetryTemplate retryTemplate = SpringUtil.getBean("aiRetryTemplate", RetryTemplate.class);

            String prompt = task.getPrompt();
            Type typeToken = task.getTypeToken();
            String tips = task.getTips();

            // 使用内部重试机制，而不是外部传入的RetryTemplate
            RetryCallback<Object, Throwable> callback = context -> {
                String responseResult = AIRequestUtils.modelStudio(prompt, modelType);

                if (typeToken.equals(String.class)) {
                    return (String) responseResult;
                }

                assert responseResult != null;
                int start = responseResult.indexOf('{');
                int end = responseResult.lastIndexOf('}');
                if (start == -1 || end == -1) {
                    throw new IllegalArgumentException("Invalid JSON format");
                }

                try {
                    responseResult = responseResult.substring(start, end + 1);
                    Gson gson = new Gson();
                    Object o = gson.fromJson(responseResult, typeToken);
                    return gson.fromJson(responseResult, typeToken);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            };

            try {
                task.getFuture().complete(retryTemplate.execute(callback));
            } catch (Throwable e) {
                LOG.error("retryTemplate 执行失败 - 任务：{}, 模型: {}, 错误: {}", tips, modelType, e.getMessage(), e);
                throw new RuntimeException(e);
            }
//            LOG.info("任务执行完成 - 模型: {}, 优先级: {}, 提示: {}", task.getModelType(), task.getPriority(), task.getTips());
        }
    }

    /**
     * 带重试的AI请求执行
     */
    private Object executeAiRequestWithRetry(String prompt, String modelType, Type typeToken, String tips) {
        RetryTemplate retryTemplate = SpringUtil.getBean("aiRetryTemplate", RetryTemplate.class);

        // 使用内部重试机制，而不是外部传入的RetryTemplate
        RetryCallback<Object, Throwable> callback = context -> {
            String responseResult = AIRequestUtils.modelStudio(prompt, modelType);

            if (typeToken.equals(String.class)) {
                return (String) responseResult;
            }

            assert responseResult != null;
            int start = responseResult.indexOf('{');
            int end = responseResult.lastIndexOf('}');
            if (start == -1 || end == -1) {
                throw new IllegalArgumentException("Invalid JSON format");
            }

            try {
                responseResult = responseResult.substring(start, end + 1);
                Gson gson = new Gson();
                Object o = gson.fromJson(responseResult, typeToken);
                return gson.fromJson(responseResult, typeToken);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        };

        try {
            return retryTemplate.execute(callback);
        } catch (Throwable e) {
            LOG.error("AI请求失败 - 任务：{}, 模型: {}, 错误: {}", tips, modelType, e.getMessage(), e);
            throw new RuntimeException(e);
        }
    }

    /**
     * 设置请求间隔
     */
    public void setRequestInterval(long intervalMs) {
        this.requestInterval = intervalMs;
        LOG.info("请求间隔已更新为: {}ms", intervalMs);
    }

    /**
     * 获取当前队列大小
     */
    public int getQueueSize(String modelType) {
        PriorityBlockingQueue<PriorityTask> queue = modelQueueMap.get(modelType);
        return queue != null ? queue.size() : 0;
    }

    /**
     * 停止某个模型的执行器
     */
    public void stopExecutor(String modelType) {
        ScheduledExecutorService executor = executorServiceMap.remove(modelType);
        if (executor != null) {
            executor.shutdown();
            try {
                if (executor.awaitTermination(5, TimeUnit.SECONDS)) {
                    LOG.info("模型 {} 的执行器已正常关闭", modelType);
                } else {
                    executor.shutdownNow();
                    LOG.warn("模型 {} 的执行器强制关闭", modelType);
                }
            } catch (InterruptedException e) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
    }

    @PreDestroy
    public void destroy() {
        // 关闭所有执行器
        for (ScheduledExecutorService executor : executorServiceMap.values()) {
            executor.shutdown();
        }

        try {
            for (ScheduledExecutorService executor : executorServiceMap.values()) {
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    executor.shutdownNow();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        LOG.info("PriorityKeyBasedRateLimiter 已关闭");
    }

    /**
     * 启动结果处理线程（可选实现，用于CompletableFuture结果处理）
     */
    private <T> void startResultProcessor(String modelType, PriorityBlockingQueue<PriorityTask> queue, CompletableFuture<T> future) {
        // 这里可以实现一个监控线程来处理任务结果和CompletableFuture的完成
    }
}

class PriorityTaskComparator implements Comparator<PriorityTask> {
    @Override
    public int compare(PriorityTask t1, PriorityTask t2) {
        // 优先级数字越小优先级越高
        int priorityCompare = Integer.compare(t1.getPriority(), t2.getPriority());
        if (priorityCompare != 0) {
            return priorityCompare;
        }
        // 相同优先级按提交时间排序（FIFO）
        return Long.compare(t1.getSubmitTime(), t2.getSubmitTime());
    }
}