package com.sentum.pojo.enums;

/**
 * 任务执行结果枚举
 */
public enum TaskResult {
    SUCCESS("成功"),
    FAILED("失败"),
    CANCELLED("已取消"),
    TIMEOUT("超时");

    private final String description;

    TaskResult(String description) {
        this.description = description;
    }

    public String getDescription() {
        return description;
    }
}
