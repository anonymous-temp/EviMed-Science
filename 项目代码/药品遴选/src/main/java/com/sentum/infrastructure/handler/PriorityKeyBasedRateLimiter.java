package com.sentum.infrastructure.handler;

import com.google.common.util.concurrent.RateLimiter;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 限流器
 * DateTime: 2025/9/18
 */
@Slf4j
@Component
public class PriorityKeyBasedRateLimiter {

    // 正常模式下的限流器（每分钟600次）
    private static final double NORMAL_RATE = 600.0 / 60; // 转换为每秒10次

    // 限流模式下的限流器（每10秒5次）
    private static final double THROTTLED_RATE = 5.0 / 10; // 转换为每秒0.5次

    // 30秒内的阈值
    private static final int THRESHOLD_IN_30S = 300;

    // 时间窗口（30秒）
    private static final long TIME_WINDOW = 30 * 1000;

    // 最大等待时间（毫秒）
    private static final long MAX_WAIT_TIME = 30 * 1000;

    // key对应的限流器
    private final Map<String, RateLimiter> rateLimiters = new ConcurrentHashMap<>();

    // key对应的请求计数
    private final Map<String, RequestCounter> requestCounters = new ConcurrentHashMap<>();

    // key的限流状态
    private final Map<String, ThrottleStatus> throttleStatuses = new ConcurrentHashMap<>();

    // 优先级队列（每个key一个队列）
    private final Map<String, PriorityBlockingQueue<PriorityRequest>> priorityQueues = new ConcurrentHashMap<>();

    // 队列处理线程池
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);

    // 请求ID生成器
    private final AtomicLong requestIdGenerator = new AtomicLong(0);

    public PriorityKeyBasedRateLimiter() {
        // 每分钟清理一次过期数据
        scheduler.scheduleAtFixedRate(this::cleanupExpiredData, 1, 1, TimeUnit.MINUTES);

        // 每100ms处理一次优先级队列
        scheduler.scheduleAtFixedRate(this::processPriorityQueues, 0, 100, TimeUnit.MILLISECONDS);
    }

    /**
     * 尝试获取令牌（带优先级）
     * @param key 限流key
     * @param priority 优先级（1-100，100最高）
     * @param timeout 超时时间
     * @param unit 时间单位
     * @return 是否获取成功
     */
    public boolean tryAcquire(String key, int priority, long timeout, TimeUnit unit) {
        // 验证优先级范围
        if (priority < 1 || priority > 100) {
            throw new IllegalArgumentException("优先级必须在1-100之间，100为最高优先级");
        }

        // 更新请求计数
        updateRequestCount(key);

        // 检查是否需要切换到限流模式
        boolean isThrottled = checkAndUpdateThrottleStatus(key);

        // 如果不是限流状态，直接尝试获取令牌
        if (!isThrottled) {
            RateLimiter limiter = getRateLimiterForKey(key, false);
            return limiter.tryAcquire(timeout, unit);
        }

        // 限流状态下，进入优先级队列
        return acquireWithPriority(key, priority, timeout, unit);
    }

    /**
     * 带优先级的令牌获取
     */
    private boolean acquireWithPriority(String key, int priority, long timeout, TimeUnit unit) {
        PriorityBlockingQueue<PriorityRequest> queue = priorityQueues.computeIfAbsent(
                key, k -> new PriorityBlockingQueue<>()
        );

        // 创建优先级请求
        PriorityRequest request = new PriorityRequest(
                requestIdGenerator.incrementAndGet(),
                key,
                priority,
                System.currentTimeMillis()
        );

        // 加入优先级队列
        queue.offer(request);

        // 等待获取令牌
        try {
            return request.waitForPermit(timeout, unit);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            queue.remove(request);
            return false;
        }
    }

    /**
     * 处理优先级队列
     */
    private void processPriorityQueues() {
        for (Map.Entry<String, PriorityBlockingQueue<PriorityRequest>> entry : priorityQueues.entrySet()) {
            String key = entry.getKey();
            PriorityBlockingQueue<PriorityRequest> queue = entry.getValue();

            if (queue.isEmpty()) {
                continue;
            }

            // 获取限流器
            ThrottleStatus status = throttleStatuses.get(key);
            boolean isThrottled = status != null && status.isThrottled();
            RateLimiter limiter = getRateLimiterForKey(key, isThrottled);

            // 处理队列中的请求
            List<PriorityRequest> expiredRequests = new ArrayList<>();

            while (!queue.isEmpty() && limiter.tryAcquire()) {
                PriorityRequest request = queue.poll();
                if (request != null) {
                    // 检查是否超时
                    if (System.currentTimeMillis() - request.getCreateTime() > MAX_WAIT_TIME) {
                        expiredRequests.add(request);
                    } else {
                        // 授予令牌
                        request.grantPermit();
                        log.debug("授予令牌 - Key: {}, 优先级: {}, 请求ID: {}",
                                key, request.getPriority(), request.getId());
                    }
                }
            }

            // 处理超时的请求
            for (PriorityRequest request : expiredRequests) {
                request.timeout();
                log.warn("请求超时 - Key: {}, 优先级: {}, 请求ID: {}",
                        key, request.getPriority(), request.getId());
            }
        }
    }

    /**
     * 获取key对应的限流器
     */
    private RateLimiter getRateLimiterForKey(String key, boolean isThrottled) {
        double rate = isThrottled ? THROTTLED_RATE : NORMAL_RATE;

        return rateLimiters.compute(key, (k, existingLimiter) -> {
            if (existingLimiter == null) {
                return RateLimiter.create(rate);
            } else {
                if (Math.abs(existingLimiter.getRate() - rate) > 0.0001) {
                    existingLimiter.setRate(rate);
                }
                return existingLimiter;
            }
        });
    }

    /**
     * 更新请求计数
     */
    private void updateRequestCount(String key) {
        long currentTime = System.currentTimeMillis();

        requestCounters.compute(key, (k, counter) -> {
            if (counter == null) {
                counter = new RequestCounter();
            }
            counter.addRequest(currentTime);
            return counter;
        });
    }

    /**
     * 检查并更新限流状态
     * @return 是否处于限流状态
     */
    private boolean checkAndUpdateThrottleStatus(String key) {
        RequestCounter counter = requestCounters.get(key);
        if (counter == null) {
            return false;
        }

        long currentTime = System.currentTimeMillis();
        int countIn30s = counter.getCountInWindow(currentTime, TIME_WINDOW);
        log.info("Key [{}] 30秒内请求数: {}", key, countIn30s);
        
        ThrottleStatus status = throttleStatuses.computeIfAbsent(key, k -> new ThrottleStatus());

        // 如果30秒内请求数达到阈值，开启限流
        if (countIn30s >= THRESHOLD_IN_30S && !status.isThrottled()) {
            status.startThrottle(currentTime);
            log.info("Key [{}] 进入限流模式，30秒内请求数: {}", key, countIn30s);
        }

        // 如果限流时间超过30秒，解除限流
        if (status.isThrottled() && currentTime - status.getThrottleStartTime() > TIME_WINDOW) {
            status.stopThrottle();
            log.info("Key [{}] 解除限流模式", key);

            // 重置计数器
            counter.reset();

            // 清空优先级队列
            PriorityBlockingQueue<PriorityRequest> queue = priorityQueues.get(key);
            if (queue != null) {
                queue.clear();
            }
        }

        return status.isThrottled();
    }

    /**
     * 清理过期数据
     */
    private void cleanupExpiredData() {
        long currentTime = System.currentTimeMillis();

        // 清理超过5分钟没有使用的key
        rateLimiters.entrySet().removeIf(entry -> {
            String key = entry.getKey();
            RequestCounter counter = requestCounters.get(key);
            if (counter != null && currentTime - counter.getLastRequestTime() > 5 * 60 * 1000) {
                requestCounters.remove(key);
                throttleStatuses.remove(key);
                priorityQueues.remove(key);
                return true;
            }
            return false;
        });
    }

    /**
     * 优先级请求
     */
    private static class PriorityRequest implements Comparable<PriorityRequest> {
        private final long id;
        private final String key;
        private final int priority;
        private final long createTime;
        private final CompletableFuture<Boolean> future;

        public PriorityRequest(long id, String key, int priority, long createTime) {
            this.id = id;
            this.key = key;
            this.priority = priority;
            this.createTime = createTime;
            this.future = new CompletableFuture<>();
        }

        @Override
        public int compareTo(PriorityRequest other) {
            // 优先级高的排在前面（降序）
            int priorityCompare = Integer.compare(other.priority, this.priority);
            if (priorityCompare != 0) {
                return priorityCompare;
            }
            // 优先级相同时，先到先得（升序）
            return Long.compare(this.createTime, other.createTime);
        }

        public void grantPermit() {
            future.complete(true);
        }

        public void timeout() {
            future.complete(false);
        }

        public boolean waitForPermit(long timeout, TimeUnit unit) throws InterruptedException {
            try {
                return future.get(timeout, unit);
            } catch (TimeoutException e) {
                return false;
            } catch (ExecutionException e) {
                throw new RuntimeException(e.getCause());
            }
        }

        // Getters
        public long getId() { return id; }
        public String getKey() { return key; }
        public int getPriority() { return priority; }
        public long getCreateTime() { return createTime; }
    }

    /**
     * 请求计数器（内部类实现保持不变）
     */
    private static class RequestCounter {
        private final List<Long> timestamps = new CopyOnWriteArrayList<>();

        public void addRequest(long timestamp) {
            timestamps.add(timestamp);
            // 只保留最近1分钟的数据
            timestamps.removeIf(t -> timestamp - t > 60 * 1000);
        }

        public int getCountInWindow(long currentTime, long windowSize) {
            return (int) timestamps.stream()
                    .filter(t -> currentTime - t <= windowSize)
                    .count();
        }

        public long getLastRequestTime() {
            return timestamps.isEmpty() ? 0 : timestamps.get(timestamps.size() - 1);
        }

        public void reset() {
            timestamps.clear();
        }
    }

    /**
     * 限流状态（内部类实现保持不变）
     */
    private static class ThrottleStatus {
        private volatile boolean throttled = false;
        private volatile long throttleStartTime = 0;

        public boolean isThrottled() {
            return throttled;
        }

        public void startThrottle(long startTime) {
            this.throttled = true;
            this.throttleStartTime = startTime;
        }

        public void stopThrottle() {
            this.throttled = false;
            this.throttleStartTime = 0;
        }

        public long getThrottleStartTime() {
            return throttleStartTime;
        }
    }

    /**
     * 获取当前状态信息（用于监控）
     */
    public Map<String, RateLimiterStatus> getStatus() {
        Map<String, RateLimiterStatus> statusMap = new HashMap<>();

        for (String key : rateLimiters.keySet()) {
            RateLimiterStatus status = new RateLimiterStatus();

            ThrottleStatus throttleStatus = throttleStatuses.get(key);
            status.setThrottled(throttleStatus != null && throttleStatus.isThrottled());

            RequestCounter counter = requestCounters.get(key);
            if (counter != null) {
                status.setRequestsIn30s(counter.getCountInWindow(System.currentTimeMillis(), TIME_WINDOW));
            }

            PriorityBlockingQueue<PriorityRequest> queue = priorityQueues.get(key);
            if (queue != null) {
                status.setQueueSize(queue.size());
            }

            statusMap.put(key, status);
        }

        return statusMap;
    }

    @Data
    public static class RateLimiterStatus {
        private boolean throttled;
        private int requestsIn30s;
        private int queueSize;
    }
}
