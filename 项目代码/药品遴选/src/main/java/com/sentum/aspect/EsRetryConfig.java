package com.sentum.aspect;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.retry.annotation.EnableRetry;
import org.springframework.retry.backoff.FixedBackOffPolicy;
import org.springframework.retry.policy.SimpleRetryPolicy;
import org.springframework.retry.support.RetryTemplate;

@Configuration
@EnableRetry // 启用重试机制
public class EsRetryConfig {

    /**
     * 定义 Elasticsearch 操作的重试模板
     * 超过20秒超时后重试，最多重试2次，每次间隔1秒
     */
    @Bean(name = "esRetryTemplate")
    public RetryTemplate esRetryTemplate() {
        // 1. 重试策略：最多重试2次
        SimpleRetryPolicy retryPolicy = new SimpleRetryPolicy();
        retryPolicy.setMaxAttempts(3); // 最大重试次数（不含首次尝试）

        // 2. 退避策略：重试间隔1秒
        FixedBackOffPolicy backOffPolicy = new FixedBackOffPolicy();
        backOffPolicy.setBackOffPeriod(1000); // 重试间隔时间（毫秒）

        // 3. 构建重试模板
        RetryTemplate retryTemplate = new RetryTemplate();
        retryTemplate.setRetryPolicy(retryPolicy);
        retryTemplate.setBackOffPolicy(backOffPolicy);

        return retryTemplate;
    }
}
    