package com.sentum.infrastructure.handler;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Objects;

/**
 * 任务性能摘要
 * 提供任务执行的关键性能指标汇总
 */
public class TaskPerformanceSummary {

    private final String taskName;
    private final TaskResult result;
    private final long totalTime;
    private final long executionTime;
    private final long queueWaitTime;
    private final long retryCount;
    private final long peakMemoryUsage;
    private final double cpuUsage;
    private final double executionEfficiency;

    // 性能等级
    private final PerformanceLevel performanceLevel;

    // 创建时间戳
    private final long summaryCreateTime;

    public TaskPerformanceSummary(String taskName, TaskResult result, long totalTime,
                                  long executionTime, long queueWaitTime, long retryCount,
                                  long peakMemoryUsage, double cpuUsage, double executionEfficiency) {
        this.taskName = taskName;
        this.result = result;
        this.totalTime = totalTime;
        this.executionTime = executionTime;
        this.queueWaitTime = queueWaitTime;
        this.retryCount = retryCount;
        this.peakMemoryUsage = peakMemoryUsage;
        this.cpuUsage = cpuUsage;
        this.executionEfficiency = executionEfficiency;
        this.summaryCreateTime = System.currentTimeMillis();

        // 计算性能等级
        this.performanceLevel = calculatePerformanceLevel();
    }

    /**
     * 计算任务性能等级
     */
    private PerformanceLevel calculatePerformanceLevel() {
        int score = 0;

        // 执行结果评分 (40分)
        switch (result) {
            case SUCCESS:
                score += 40;
                break;
            case FAILED:
                score += 0;
                break;
            case CANCELLED:
                score += 10;
                break;
            default:
                score += 20;
        }

        // 执行效率评分 (30分)
        if (executionEfficiency >= 0.8) {
            score += 30;
        } else if (executionEfficiency >= 0.6) {
            score += 25;
        } else if (executionEfficiency >= 0.4) {
            score += 20;
        } else if (executionEfficiency >= 0.2) {
            score += 15;
        } else {
            score += 10;
        }

        // 重试次数评分 (15分)
        if (retryCount == 0) {
            score += 15;
        } else if (retryCount <= 2) {
            score += 10;
        } else if (retryCount <= 5) {
            score += 5;
        } else {
            score += 0;
        }

        // 执行时间评分 (15分) - 基于任务类型的合理时间范围
        long reasonableTime = getReasonableExecutionTime();
        if (executionTime <= reasonableTime) {
            score += 15;
        } else if (executionTime <= reasonableTime * 2) {
            score += 10;
        } else if (executionTime <= reasonableTime * 3) {
            score += 5;
        } else {
            score += 0;
        }

        // 根据总分确定性能等级
        if (score >= 85) {
            return PerformanceLevel.EXCELLENT;
        } else if (score >= 70) {
            return PerformanceLevel.GOOD;
        } else if (score >= 55) {
            return PerformanceLevel.AVERAGE;
        } else if (score >= 40) {
            return PerformanceLevel.POOR;
        } else {
            return PerformanceLevel.CRITICAL;
        }
    }

    /**
     * 根据任务名称获取合理的执行时间（毫秒）
     */
    private long getReasonableExecutionTime() {
        String lowerTaskName = taskName.toLowerCase();

        if (lowerTaskName.contains("recipe") || lowerTaskName.contains("theory")) {
            return 5000; // 5秒
        } else if (lowerTaskName.contains("guide") || lowerTaskName.contains("search")) {
            return 30000; // 30秒
        } else if (lowerTaskName.contains("paper") || lowerTaskName.contains("literature")) {
            return 20000; // 20秒
        } else if (lowerTaskName.contains("disease") || lowerTaskName.contains("medicine")) {
            return 8000; // 8秒
        } else {
            return 10000; // 默认10秒
        }
    }

    /**
     * 判断是否为慢任务
     */
    public boolean isSlowTask() {
        return executionTime > getReasonableExecutionTime() * 2;
    }

    /**
     * 判断是否为高效任务
     */
    public boolean isEfficientTask() {
        return executionEfficiency >= 0.8 && retryCount == 0 && result == TaskResult.SUCCESS;
    }

    /**
     * 判断是否需要优化
     */
    public boolean needsOptimization() {
        return performanceLevel == PerformanceLevel.POOR ||
                performanceLevel == PerformanceLevel.CRITICAL ||
                retryCount > 3 ||
                executionEfficiency < 0.3;
    }

    /**
     * 获取性能建议
     */
    public String getPerformanceAdvice() {
        StringBuilder advice = new StringBuilder();

        if (retryCount > 3) {
            advice.append("• 重试次数过多，建议检查任务逻辑或增加错误处理\n");
        }

        if (executionEfficiency < 0.5) {
            advice.append("• 执行效率较低，建议优化任务逻辑或减少等待时间\n");
        }

        if (queueWaitTime > executionTime) {
            advice.append("• 队列等待时间过长，建议增加线程池大小或优化任务调度\n");
        }

        if (isSlowTask()) {
            advice.append("• 执行时间超出预期，建议进行性能优化\n");
        }

        if (peakMemoryUsage > 100 * 1024 * 1024) { // 100MB
            advice.append("• 内存使用量较高，建议检查内存泄漏或优化内存使用\n");
        }

        if (advice.length() == 0) {
            advice.append("• 任务执行良好，无需特别优化");
        }

        return advice.toString();
    }

    /**
     * 生成简要报告
     */
    public String generateBriefReport() {
        return String.format(
                "任务: %s | 状态: %s | 性能: %s | 总耗时: %dms | 执行时间: %dms | 效率: %.1f%% | 重试: %d次",
                taskName, result.getDescription(), performanceLevel.getDescription(),
                totalTime, executionTime, executionEfficiency * 100, retryCount
        );
    }

    /**
     * 生成详细报告
     */
    public String generateDetailedReport() {
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
        LocalDateTime createTime = LocalDateTime.ofInstant(
                java.time.Instant.ofEpochMilli(summaryCreateTime),
                java.time.ZoneId.systemDefault()
        );

        StringBuilder report = new StringBuilder();
        report.append("╔══════════════════════════════════════════════════════════════╗\n");
        report.append("║                        任务性能摘要                          ║\n");
        report.append("╠══════════════════════════════════════════════════════════════╣\n");
        report.append(String.format("║ 任务名称: %-50s ║\n", taskName));
        report.append(String.format("║ 执行状态: %-50s ║\n", result.getDescription()));
        report.append(String.format("║ 性能等级: %-50s ║\n", performanceLevel.getDescription()));
        report.append("╠══════════════════════════════════════════════════════════════╣\n");
        report.append(String.format("║ 总耗时:   %-15d ms  队列等待: %-15d ms ║\n", totalTime, queueWaitTime));
        report.append(String.format("║ 执行时间: %-15d ms  执行效率: %-15.1f%% ║\n", executionTime, executionEfficiency * 100));
        report.append(String.format("║ 重试次数: %-15d     峰值内存: %-15s ║\n", retryCount, formatMemory(peakMemoryUsage)));
        report.append(String.format("║ CPU使用:  %-15.1f%%   报告时间: %-15s ║\n", cpuUsage, createTime.format(formatter)));
        report.append("╠══════════════════════════════════════════════════════════════╣\n");
        report.append("║ 性能建议:                                                    ║\n");

        String[] adviceLines = getPerformanceAdvice().split("\n");
        for (String line : adviceLines) {
            if (line.trim().length() > 0) {
                report.append(String.format("║ %-60s ║\n", line));
            }
        }

        report.append("╚══════════════════════════════════════════════════════════════╝\n");

        return report.toString();
    }

    /**
     * 转换为JSON格式
     */
    public String toJson() {
        return String.format(
                "{\"taskName\":\"%s\",\"result\":\"%s\",\"performanceLevel\":\"%s\"," +
                        "\"totalTime\":%d,\"executionTime\":%d,\"queueWaitTime\":%d," +
                        "\"retryCount\":%d,\"peakMemoryUsage\":%d,\"cpuUsage\":%.2f," +
                        "\"executionEfficiency\":%.4f,\"summaryCreateTime\":%d," +
                        "\"isSlowTask\":%b,\"isEfficientTask\":%b,\"needsOptimization\":%b}",
                taskName, result, performanceLevel, totalTime, executionTime, queueWaitTime,
                retryCount, peakMemoryUsage, cpuUsage, executionEfficiency, summaryCreateTime,
                isSlowTask(), isEfficientTask(), needsOptimization()
        );
    }

    /**
     * 格式化内存大小
     */
    private String formatMemory(long bytes) {
        if (bytes < 1024) return bytes + "B";
        int exp = (int) (Math.log(bytes) / Math.log(1024));
        String pre = "KMGTPE".charAt(exp - 1) + "";
        return String.format("%.1f%sB", bytes / Math.pow(1024, exp), pre);
    }

    /**
     * 比较两个性能摘要
     */
    public int comparePerformance(TaskPerformanceSummary other) {
        // 首先比较性能等级
        int levelCompare = this.performanceLevel.compareTo(other.performanceLevel);
        if (levelCompare != 0) {
            return -levelCompare; // 性能等级高的排前面
        }

        // 性能等级相同时，比较执行效率
        int efficiencyCompare = Double.compare(this.executionEfficiency, other.executionEfficiency);
        if (efficiencyCompare != 0) {
            return -efficiencyCompare; // 效率高的排前面
        }

        // 效率相同时，比较执行时间
        return Long.compare(this.executionTime, other.executionTime); // 时间短的排前面
    }

    // Getters
    public String getTaskName() { return taskName; }
    public TaskResult getResult() { return result; }
    public long getTotalTime() { return totalTime; }
    public long getExecutionTime() { return executionTime; }
    public long getQueueWaitTime() { return queueWaitTime; }
    public long getRetryCount() { return retryCount; }
    public long getPeakMemoryUsage() { return peakMemoryUsage; }
    public double getCpuUsage() { return cpuUsage; }
    public double getExecutionEfficiency() { return executionEfficiency; }
    public PerformanceLevel getPerformanceLevel() { return performanceLevel; }
    public long getSummaryCreateTime() { return summaryCreateTime; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof TaskPerformanceSummary)) return false;
        TaskPerformanceSummary that = (TaskPerformanceSummary) o;
        return totalTime == that.totalTime &&
                executionTime == that.executionTime &&
                queueWaitTime == that.queueWaitTime &&
                retryCount == that.retryCount &&
                peakMemoryUsage == that.peakMemoryUsage &&
                Double.compare(that.cpuUsage, cpuUsage) == 0 &&
                Double.compare(that.executionEfficiency, executionEfficiency) == 0 &&
                summaryCreateTime == that.summaryCreateTime &&
                Objects.equals(taskName, that.taskName) &&
                result == that.result &&
                performanceLevel == that.performanceLevel;
    }

    @Override
    public int hashCode() {
        return Objects.hash(taskName, result, totalTime, executionTime, queueWaitTime,
                retryCount, peakMemoryUsage, cpuUsage, executionEfficiency,
                performanceLevel, summaryCreateTime);
    }

    @Override
    public String toString() {
        return generateBriefReport();
    }
}

/**
 * 性能等级枚举
 */
enum PerformanceLevel {
    EXCELLENT("优秀", "🟢", 5),
    GOOD("良好", "🔵", 4),
    AVERAGE("一般", "🟡", 3),
    POOR("较差", "🟠", 2),
    CRITICAL("严重", "🔴", 1);

    private final String description;
    private final String icon;
    private final int level;

    PerformanceLevel(String description, String icon, int level) {
        this.description = description;
        this.icon = icon;
        this.level = level;
    }

    public String getDescription() {
        return description;
    }

    public String getIcon() {
        return icon;
    }

    public int getLevel() {        return level;
    }
}
