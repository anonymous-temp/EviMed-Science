package com.sentum.evidencecomprehensive.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.retry.RetryCallback;
import org.springframework.retry.RetryContext;
import org.springframework.retry.RetryListener;


/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/31
 */
public class LoggingRetryListener implements RetryListener {

    private static final Logger logger = LoggerFactory.getLogger(LoggingRetryListener.class);

    @Override
    public <T, E extends Throwable> boolean open(RetryContext context, RetryCallback<T, E> callback) {
        ParameterizedRetryCallback<?> paramCallback = (ParameterizedRetryCallback<?>) callback;
        String tips = paramCallback.getTips();
        logger.info("Starting retry operation with parameters - tips: {}", tips);
        return true;
    }

    @Override
    public <T, E extends Throwable> void close(RetryContext context, RetryCallback<T, E> callback, Throwable throwable) {
        String tips = (String) context.getAttribute("tips");
        logger.info("Retry operation completed with parameters - tips: {}", tips);
    }

    @Override
    public <T, E extends Throwable> void onError(RetryContext context, RetryCallback<T, E> callback, Throwable throwable) {
        // Called after each failed attempt
        logger.warn("Retry attempt {} failed due to: {}", context.getRetryCount(), throwable.getMessage());
    }

    // 辅助方法：截断过长的 prompt
    private String truncate(String text, int maxLength) {
        if (text == null) {
            return "null";
        }
        if (text.length() <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + "...";
    }
}
