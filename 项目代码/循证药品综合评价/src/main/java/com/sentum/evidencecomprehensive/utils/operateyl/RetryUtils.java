package com.sentum.evidencecomprehensive.utils.operateyl;

import cn.hutool.extra.spring.SpringUtil;
import com.google.gson.Gson;
import com.sentum.evidencecomprehensive.config.ParameterizedRetryCallback;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.retry.RetryCallback;
import org.springframework.retry.support.RetryTemplate;

import java.lang.reflect.Type;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/31
 */
public class RetryUtils {
    
    private static final Logger LOG = LoggerFactory.getLogger(RetryUtils.class);
    @SuppressWarnings("unchecked")
    public static <T> T executeWithRetry(String prompt, String modelType, Type typeToken, String tips) {
        RetryTemplate retryTemplate = SpringUtil.getBean(RetryTemplate.class);

        RetryCallback<T, Throwable> actualCallback = context -> {
            String summaryResult = AIRequestUtils.modelStudio(prompt, modelType);

            if (typeToken.equals(String.class)) {
                return (T) summaryResult;
            }

            int start = summaryResult.indexOf('{');
            int end = summaryResult.lastIndexOf('}');
            if (start == -1 || end == -1) {
                throw new IllegalArgumentException("Invalid JSON format");
            }

            summaryResult = summaryResult.substring(start, end + 1);
            Gson gson = new Gson();
            return gson.fromJson(summaryResult, typeToken);
        };

        ParameterizedRetryCallback<T> parametrizedCallback =
                new ParameterizedRetryCallback<>(prompt, modelType, typeToken, tips, actualCallback);

        try {
            return retryTemplate.execute(parametrizedCallback);
        } catch (Throwable e) {
            LOG.error(e.getMessage(), e);
            throw new RuntimeException(e);
        }
    }
}
