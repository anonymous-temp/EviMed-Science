package com.sentum.infrastructure.handler;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 任务执行指标收集器
 * 用于监控和统计任务执行情况
 */
public class TaskMetrics {

    private final String taskName;
    private final long createTime;
    private final AtomicLong startTime;
    private final AtomicLong endTime;
    private final AtomicLong executionTime;
    private final AtomicReference<TaskResult> result;
    private final AtomicReference<Exception> exception;

    // 统计信息
    private final AtomicLong retryCount;
    private final AtomicLong memoryUsed;
    private final AtomicReference<String> executorName;
    private final AtomicReference<String> threadName;

    // 性能指标
    private volatile double cpuUsage;
    private volatile long peakMemoryUsage;
    private volatile int queueWaitTime; // 在队列中等待的时间

    public TaskMetrics(String taskName, long createTime) {
        this.taskName = taskName;
        this.createTime = createTime;
        this.startTime = new AtomicLong(0);
        this.endTime = new AtomicLong(0);
        this.executionTime = new AtomicLong(0);
        this.result = new AtomicReference<>(TaskResult.PENDING);
        this.exception = new AtomicReference<>();
        this.retryCount = new AtomicLong(0);
        this.memoryUsed = new AtomicLong(0);
        this.executorName = new AtomicReference<>("Unknown");
        this.threadName = new AtomicReference<>("Unknown");
    }

    /**
     * 标记任务开始执行
     */
    public void setStartTime(long startTime) {
        this.startTime.set(startTime);
        this.queueWaitTime = (int) (startTime - createTime);
        this.threadName.set(Thread.currentThread().getName());
        this.result.set(TaskResult.RUNNING);
    }

    /**
     * 标记任务完成
     */
    public void setCompleted(long executionTime) {
        this.endTime.set(System.currentTimeMillis());
        this.executionTime.set(executionTime);
        this.result.set(TaskResult.SUCCESS);
    }

    /**
     * 标记任务失败
     */
    public void setFailed(Exception exception) {
        this.endTime.set(System.currentTimeMillis());
        this.executionTime.set(this.endTime.get() - this.startTime.get());
        this.exception.set(exception);
        this.result.set(TaskResult.FAILED);
    }

    /**
     * 标记任务取消
     */
    public void setCancelled() {
        this.endTime.set(System.currentTimeMillis());
        if (this.startTime.get() > 0) {
            this.executionTime.set(this.endTime.get() - this.startTime.get());
        }
        this.result.set(TaskResult.CANCELLED);
    }

    /**
     * 增加重试次数
     */
    public void incrementRetryCount() {
        this.retryCount.incrementAndGet();
    }

    /**
     * 设置执行器名称
     */
    public void setExecutorName(String executorName) {
        this.executorName.set(executorName);
    }

    /**
     * 更新内存使用情况
     */
    public void updateMemoryUsage(long memoryUsed) {
        this.memoryUsed.set(memoryUsed);
        if (memoryUsed > this.peakMemoryUsage) {
            this.peakMemoryUsage = memoryUsed;
        }
    }

    /**
     * 设置CPU使用率
     */
    public void setCpuUsage(double cpuUsage) {
        this.cpuUsage = cpuUsage;
    }

    /**
     * 获取总耗时（从创建到完成）
     */
    public long getTotalTime() {
        long end = endTime.get() > 0 ? endTime.get() : System.currentTimeMillis();
        return end - createTime;
    }
    
    /**
     * 获取任务执行时间
     */
    public long getExecutionTime() {
        return executionTime.get();
    }

    /**
     * 获取任务开始执行时间
     */
    public long getStartTime() {
        return startTime.get();
    }
    

    /**
     * 获取执行效率（执行时间/总时间）
     */
    public double getExecutionEfficiency() {
        long total = getTotalTime();
        return total > 0 ? (double) executionTime.get() / total : 0.0;
    }

    /**
     * 判断任务是否超时
     */
    public boolean isTimeout(long timeoutMs) {
        return getTotalTime() > timeoutMs;
    }

    /**
     * 判断任务是否执行缓慢
     */
    public boolean isSlowTask(long slowThresholdMs) {
        return executionTime.get() > slowThresholdMs;
    }

    /**
     * 获取任务性能摘要
     */
    public TaskPerformanceSummary getPerformanceSummary() {
        return new TaskPerformanceSummary(
                taskName,
                result.get(),
                getTotalTime(),
                executionTime.get(),
                queueWaitTime,
                retryCount.get(),
                peakMemoryUsage,
                cpuUsage,
                getExecutionEfficiency()
        );
    }

    /**
     * 生成详细报告
     */
    public String generateDetailedReport() {
        StringBuilder report = new StringBuilder();
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

        report.append("=== 任务执行报告 ===\n");
        report.append("任务名称: ").append(taskName).append("\n");
        report.append("执行状态: ").append(result.get().getDescription()).append("\n");
        report.append("创建时间: ").append(LocalDateTime.ofInstant(
                java.time.Instant.ofEpochMilli(createTime),
                java.time.ZoneId.systemDefault()).format(formatter)).append("\n");

        if (startTime.get() > 0) {
            report.append("开始时间: ").append(LocalDateTime.ofInstant(
                    java.time.Instant.ofEpochMilli(startTime.get()),
                    java.time.ZoneId.systemDefault()).format(formatter)).append("\n");
        }

        if (endTime.get() > 0) {
            report.append("结束时间: ").append(LocalDateTime.ofInstant(
                    java.time.Instant.ofEpochMilli(endTime.get()),
                    java.time.ZoneId.systemDefault()).format(formatter)).append("\n");
        }

        report.append("队列等待时间: ").append(queueWaitTime).append("ms\n");
        report.append("执行时间: ").append(executionTime.get()).append("ms\n");
        report.append("总耗时: ").append(getTotalTime()).append("ms\n");
        report.append("执行效率: ").append(String.format("%.2f%%", getExecutionEfficiency() * 100)).append("\n");
        report.append("重试次数: ").append(retryCount.get()).append("\n");
        report.append("执行线程: ").append(threadName.get()).append("\n");
        report.append("执行器: ").append(executorName.get()).append("\n");
        report.append("峰值内存: ").append(formatMemory(peakMemoryUsage)).append(" bytes\n");
        if (exception.get() != null) {
            report.append("异常信息: ").append(exception.get().getMessage()).append("\n");
        }
        report.append("====================\n");
        return report.toString();
    }

    private String formatMemory(long bytes) {
        if (bytes < 1024) return bytes + " bytes";
        int exp = (int) (Math.log(bytes) / Math.log(1024));
        String pre = " KMGTPE".charAt(exp) + "";
        return String.format("%.1f %sbytes", bytes / Math.pow(1024, exp), pre);
    }
}

/**
 * 任务执行结果枚举
 */
enum TaskResult {
    PENDING("等待执行"),
    RUNNING("执行中"),
    SUCCESS("执行成功"),
    FAILED("执行失败"),
    CANCELLED("已取消");

    private final String description;

    TaskResult(String description) {
        this.description = description;
    }

    public String getDescription() {
        return description;
    }
}
