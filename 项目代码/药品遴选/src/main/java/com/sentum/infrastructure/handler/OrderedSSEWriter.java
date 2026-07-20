package com.sentum.infrastructure.handler;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.CacheDto;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.servlet.http.HttpServletResponse;
import java.text.DecimalFormat;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/22
 */
public class OrderedSSEWriter {

    private static final Logger LOG = LoggerFactory.getLogger(OrderedSSEWriter.class);

    // 预定义的输出顺序
    private final LinkedList<String> orderedKeys;

    // 缓存已到达但还不能输出的结果
    private final Map<String, PendingResult> resultCache = new ConcurrentHashMap<>();

    // 当前等待输出的 key 索引
    private final AtomicInteger currentIndex = new AtomicInteger(0);
//    private int currentIndex = 0;

    // 响应对象和缓存列表
    private final HttpServletResponse response;
    private final List<CacheDto> cacheDtos;

    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(
            r -> {
                Thread t = new Thread(r, "OrderedSSEWriter-FlushScheduler");
                t.setDaemon(true);
                return t;
            });
    private volatile boolean isStopped = false;

    private final AtomicBoolean completed = new AtomicBoolean(false);
    private final Object completionLock = new Object();
    private volatile boolean shutdownRequested = false;


    public OrderedSSEWriter(List<String> keyOrder, HttpServletResponse response, List<CacheDto> cacheDtos) {
        this.orderedKeys = new LinkedList<>(keyOrder);
        this.response = response;
        this.cacheDtos = cacheDtos;

        // 初始化 SSE 响应头
        initSSEResponse();

        // 启动定时刷新任务
        startPeriodicFlush();
    }

    private void initSSEResponse() {
        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Connection", "keep-alive");
    }

    /**
     * 启动定期刷新任务
     */
    private void startPeriodicFlush() {
        scheduler.scheduleAtFixedRate(() -> {
            if (!isStopped) {
                try {
                    tryFlushOrderedResults();
                    // 检查是否已完成，如果是则停止调度
                    if (isCompleted()) {
//                        stopScheduler();
                        markAsCompleted();
                    }
                } catch (Exception e) {
                    LOG.error("❌ 定时刷新任务出错", e);
                }
            }
        }, 0, 2000, TimeUnit.MILLISECONDS);
    }

    /**
     * 立即停止调度器（应由外部线程调用）
     */
    public void stopScheduler() {
        if (shutdownRequested) {
            return;
        }
        shutdownRequested = true;

        isStopped = true;
        // 尝试正常关闭
        scheduler.shutdown();
        try {
            // 给很短时间让任务完成
            if (!scheduler.awaitTermination(100, TimeUnit.SECONDS)) {
                // 如果没完成，强制关闭
                scheduler.shutdownNow();
                // 再给很短时间响应中断
                scheduler.awaitTermination(100, TimeUnit.SECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            // 不记录为错误，这是正常关闭过程中的可能情况
            LOG.debug("等待定时任务终止时被中断", e);
        }
    }

//    /**
//     * 停止定时任务
//     */
//    public void stopScheduler() {
//        isStopped = true;
//        scheduler.shutdown();
//        try {
//            if (!scheduler.awaitTermination(10, TimeUnit.SECONDS)) {
//                LOG.warn("定时任务未能正常终止");
//            }
//        } catch (InterruptedException e) {
//            Thread.currentThread().interrupt();
//            LOG.error("等待定时任务终止时被中断", e);
//        }
//    }

    /**
     * 标记为已完成（线程安全）
     */
    private void markAsCompleted() {
        if (completed.compareAndSet(false, true)) {
            synchronized (completionLock) {
                completionLock.notifyAll();
            }
        }
    }

    /**
     * 由外部线程调用：等待完成并停止
     */
    public void waitForCompletionAndStop(long timeout, TimeUnit unit) {
        try {
            synchronized (completionLock) {
                if (!completed.get()) {
                    completionLock.wait(unit.toMillis(timeout));
                }
            }
            stopScheduler();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.debug("等待完成时被中断，仍尝试停止调度器", e);
            stopScheduler();
        }
    }
    

    /**
     * 线程安全的写入方法
     */
    public synchronized void write(String key, Object value, String describe) {
        // 缓存结果
        resultCache.put(key, new PendingResult(key, value, describe));

        // 尝试按顺序输出所有可以输出的结果
        tryFlushOrderedResults();
    }

    /**
     * 按顺序检查并输出结果
     */
    private synchronized void tryFlushOrderedResults() {
        while (currentIndex.get() < orderedKeys.size()) {
            String expectedKey = orderedKeys.get(currentIndex.get());

            // 检查当前期望的 key 是否已经到达
            PendingResult result = resultCache.get(expectedKey);
            if (result == null) {
                // 当前期望的结果还没到达，停止输出
                break;
            }

            // 输出这个结果
            doWrite(result);

            // 清理已输出的结果，移动到下一个
            resultCache.remove(expectedKey);
            currentIndex.incrementAndGet();
//            currentIndex++;
        }
    }

    /**
     * 实际的 SSE 输出逻辑
     */
    private void doWrite(PendingResult result) {
        try {
            // 添加到缓存列表
            CacheDto cacheDto = new CacheDto(result.key, result.value, result.describe);
            cacheDtos.add(cacheDto);

            String key = result.key;
            
            // 提取并格式化内容
            String content = extractContent(result.key, result.value);
//            content = content.replaceAll("\n", "\\\\n").replaceAll("\"", "'");
//            content = "{\"" + result.key + "\":\"" + content + "\"}";


//                try {
//                    // 配置参数
//                    int charsPerChunk = 3;        // 每次输出字符数（可调节速度）
//                    long delayMillis = 60;        // 每次输出间隔（毫秒）
//
//                    // 将长文本按字符分块流式输出
//                    for (int j = 0; j < content.length(); j += charsPerChunk) {
//                        int endI = Math.min(j + charsPerChunk, content.length());
//                        String chunk = content.substring(j, endI);
//
//                        // 输出到 SSE 流
//                        response.getWriter().write("data: " + chunk + "\n\n");
//                        response.getWriter().flush();
//
//                        // 打字间隔延迟
//                        if (endI < chunk.length()) { // 最后一块无需延迟
//                            Thread.sleep(delayMillis);
//                        }
//                    }
//
//                } catch (InterruptedException e) {
//                    Thread.currentThread().interrupt();
//                    LOG.error("❌ SSE 输出失败: key={}, error={}", result.key, e.getMessage());
//                }

            content = content.replaceAll("\\\\n\\\\n", "\\\\n");
            // 输出到 SSE 流
            response.getWriter().write("data: " + content + "\n\n");
            response.getWriter().flush();
    
            LOG.info("✅ 按序输出: {} = {}", result.key, content);
        } catch (Exception e) {
            LOG.error("❌ SSE 输出失败: key={}, error={}", result.key, e.getMessage());
        }
    }

    /**
     * 检查是否所有结果都已输出完成
     */
    public boolean isCompleted() {
        return currentIndex.get() >= orderedKeys.size() && resultCache.isEmpty();
    }

    /**
     * 获取还在等待的 keys
     */
    public List<String> getPendingKeys() {
        return orderedKeys.subList(currentIndex.get(), orderedKeys.size());
    }

    // 内部类：待输出结果
    private static class PendingResult {
        final String key;
        final Object value;
        final String describe;

        PendingResult(String key, Object value, String describe) {
            this.key = key;
            this.value = value;
            this.describe = describe;
        }
    }

    // 你原来的内容提取方法
    private String extractContent(String key, Object value) {
        // 这里放你原来的 extractContent 逻辑
        if (value == null) value = "";

        if (key.contains("Score")) {
            value = formatScore(value.toString());
        }
        
        if (key.contains("evidenceRecommendationContent") || key.contains("clinicalResearchContent") || key.contains("safetyReevaluationContent")
                || key.contains("economicAdvantageOption")) {
            return "{\"" + key + "\":" + value + "}";
        }
        if (key.contains("Json")) {
            return "{\"" + key + "\":" + value + "}";
        }

        if (key.equals("guide")) {
            if (StringUtils.isBlank(value.toString())) {
                value = new ArrayList<>();
            }
            return "{\"" + key + "\":" + JSONObject.toJSON(value) + "}";
        }

        String result = value.toString().replaceAll("\n", "\\\\n").replaceAll("\"", "'");
        if (result.endsWith("\\n")) {
            result = result.substring(0, result.length() - 2);
        }
        return "{\"" + key + "\":\"" + result + "\"}";
    }

    private String formatScore(String score) {
        if (StringUtils.isBlank(score)) return score;
        //(1) 得分为整数的，直接显示分值，数值后不需要.00。如15;
        //(2) 得分为非整数的，请保留小数点后两位有效数字。
        double number = 0;
        try {
            number = Double.parseDouble(score);
        } catch (NumberFormatException e) {
            LOG.info("得分格式化异常{}", score);
            number = extractLastNumber(score);
            LOG.info("得分格式化异常纠正为{}", number);
        }

        if (number % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(number);
        } else {
            return new DecimalFormat("#.##").format(number);
        }
    }

    private static double extractLastNumber(String input) {
        if (input == null || input.isEmpty()) {
            return 0.0;
        }

        // 定义正则表达式，匹配一个或多个数字（包括小数）
        String regex = "\\d+(\\.\\d+)?";
        Pattern pattern = Pattern.compile(regex);
        Matcher matcher = pattern.matcher(input);

        String lastNumber = null;
        // 查找所有匹配的数字
        while (matcher.find()) {
            lastNumber = matcher.group();
        }

        // 返回最后一个匹配的数字，若无匹配则返回0.0
        return lastNumber != null ? Double.parseDouble(lastNumber) : 0.0;
    }
}
