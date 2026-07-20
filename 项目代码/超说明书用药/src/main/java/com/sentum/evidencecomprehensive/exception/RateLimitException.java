package com.sentum.evidencecomprehensive.exception;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/18
 */
/**
 * 限流异常
 */
public class RateLimitException extends BusinessException {

    private String key;
    private Integer priority;
    private Long waitTime;

    public RateLimitException(String message) {
        super(429, message);
    }

    public RateLimitException(String message, Throwable cause) {
        super(429, message, cause);
    }

    public RateLimitException(String message, String key, Integer priority, Long waitTime) {
        super(429, message);
        this.key = key;
        this.priority = priority;
        this.waitTime = waitTime;
    }

    // Getters
    public String getKey() {
        return key;
    }

    public Integer getPriority() {
        return priority;
    }

    public Long getWaitTime() {
        return waitTime;
    }
}
