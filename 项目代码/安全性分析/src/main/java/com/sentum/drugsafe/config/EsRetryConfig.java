package com.sentum.drugsafe.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.retry.annotation.EnableRetry;
import org.springframework.retry.backoff.FixedBackOffPolicy;
import org.springframework.retry.policy.SimpleRetryPolicy;
import org.springframework.retry.support.RetryTemplate;

import java.util.Collections;

@Configuration
@EnableRetry
public class EsRetryConfig {

    /**
     * 定义 Elasticsearch 操作的重试模板
     * 总共执行 3 次，每次重试间隔 1 秒
     */
    @Bean(name = "esRetryTemplate")
    public RetryTemplate esRetryTemplate() {
        SimpleRetryPolicy retryPolicy = new SimpleRetryPolicy(3, Collections.singletonMap(RuntimeException.class, true), true);

        FixedBackOffPolicy backOffPolicy = new FixedBackOffPolicy();
        backOffPolicy.setBackOffPeriod(1000);

        RetryTemplate retryTemplate = new RetryTemplate();
        retryTemplate.setRetryPolicy(retryPolicy);
        retryTemplate.setBackOffPolicy(backOffPolicy);
        return retryTemplate;
    }
}