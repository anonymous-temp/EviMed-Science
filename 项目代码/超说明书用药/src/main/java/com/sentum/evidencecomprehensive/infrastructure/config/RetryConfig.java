package com.sentum.evidencecomprehensive.infrastructure.config;

import com.baomidou.mybatisplus.autoconfigure.MybatisPlusAutoConfiguration;
import com.sentum.evidencecomprehensive.exception.RateLimitException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.retry.RetryCallback;
import org.springframework.retry.RetryContext;
import org.springframework.retry.RetryListener;
import org.springframework.retry.backoff.ExponentialBackOffPolicy;
import org.springframework.retry.policy.SimpleRetryPolicy;
import org.springframework.retry.support.RetryTemplate;

import javax.inject.Qualifier;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/31
 */
@Slf4j
@Configuration
public class RetryConfig {

    @Bean
    @Primary  // 标记为主
    public RetryTemplate retryTemplate() {
        RetryTemplate retryTemplate = new RetryTemplate();

        SimpleRetryPolicy retryPolicy = new SimpleRetryPolicy();
        retryPolicy.setMaxAttempts(6); 
        retryTemplate.setRetryPolicy(retryPolicy);

        retryTemplate.registerListener(new LoggingRetryListener());

        return retryTemplate;
    }

    @Bean(name = "aiRetryTemplate")
    public RetryTemplate aiRetryTemplate() {
        // AI专用的重试模板
        RetryTemplate template = new RetryTemplate();

        Map<Class<? extends Throwable>, Boolean> retryableExceptions = new HashMap<>();
        retryableExceptions.put(RateLimitException.class, true);
        retryableExceptions.put(IOException.class, true);
        retryableExceptions.put(IllegalArgumentException.class, false);

        SimpleRetryPolicy retryPolicy = new SimpleRetryPolicy(5, retryableExceptions);
        template.setRetryPolicy(retryPolicy);

        ExponentialBackOffPolicy backOffPolicy = new ExponentialBackOffPolicy();
        backOffPolicy.setInitialInterval(1000);
        backOffPolicy.setMultiplier(3);
        backOffPolicy.setMaxInterval(100000);
        template.setBackOffPolicy(backOffPolicy);

//        // 2. 设置自定义退避策略
//        CustomIntervalBackOffPolicy backOffPolicy =
//                new CustomIntervalBackOffPolicy(1000, 5000, 15000, 20000);
//
//        template.setRetryPolicy(retryPolicy);
//        template.setBackOffPolicy(backOffPolicy);


        // 配置监听器（可选）
        template.registerListener(new RetryListener() {
            @Override
            public <T, E extends Throwable> boolean open(RetryContext retryContext, RetryCallback<T, E> retryCallback) {
                // ✅ 必须返回 true，否则会抛出 TerminatedRetryException
//                log.debug("aiRetryTemplate 首次开始 - {}", retryCallback);
                return true;  // 这是关键！
            }

            @Override
            public <T, E extends Throwable> void close(RetryContext retryContext, RetryCallback<T, E> retryCallback, Throwable throwable) {
                if (throwable == null) {
                    log.info("aiRetryTemplate 执行成功 - 总尝试次数: {}", retryContext.getRetryCount());
                } else {
                    log.warn("aiRetryTemplate 重试最终失败 - 总尝试次数: {}, 最终异常: {}",
                            retryContext.getRetryCount(), throwable.getMessage());
                }
            }

            @Override
            public <T, E extends Throwable> void onError(RetryContext context,
                                                         RetryCallback<T, E> callback,
                                                         Throwable throwable) {
//                log.info("aiRetryTemplate 执行失败 - 第{}次尝试，异常: {}", context.getRetryCount(), throwable.getMessage());
            }
        });

        return template;
    }
}
