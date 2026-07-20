package com.sentum.drugsafe.config;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Pointcut;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.retry.backoff.FixedBackOffPolicy;
import org.springframework.retry.policy.SimpleRetryPolicy;
import org.springframework.retry.support.RetryTemplate;

import java.util.Collections;

/**
 * 独立的Redis重试切面，与原有RedisConfig完全分离
 * 不影响任何原有配置，仅添加重试功能
 */
@Configuration
@Aspect
public class RedisRetryAspect {

    // 重试次数(不含首次，共3次尝试)
    private static final int MAX_RETRIES = 2;
    // 重试间隔1秒
    private static final long BACKOFF_PERIOD = 1000;

    /**
     * 重试模板配置
     */
    @Bean
    public RetryTemplate redisRetryTemplate() {
        RetryTemplate retryTemplate = new RetryTemplate();

        // 重试策略：最多重试2次(加首次共3次)
        SimpleRetryPolicy retryPolicy = new SimpleRetryPolicy(
                MAX_RETRIES + 1,
                Collections.singletonMap(Exception.class, true)
        );
        retryTemplate.setRetryPolicy(retryPolicy);

        // 退避策略：间隔1秒重试
        FixedBackOffPolicy backOffPolicy = new FixedBackOffPolicy();
        backOffPolicy.setBackOffPeriod(BACKOFF_PERIOD);
        retryTemplate.setBackOffPolicy(backOffPolicy);

        return retryTemplate;
    }

    /**
     * 切入点：拦截所有Redis操作方法（与你的RedisConfig配合工作）
     */
    @Pointcut("target(org.springframework.data.redis.core.RedisOperations) && execution(* *(..))")
    public void redisOperationsPointcut() {}

    /**
     * 环绕通知：对所有Redis操作添加重试机制
     * 完全兼容你原有的RedisConfig配置
     */
    @Around("redisOperationsPointcut()")
    public Object aroundRedisOperations(ProceedingJoinPoint joinPoint) throws Throwable {
        // 使用重试模板执行Redis操作
        return redisRetryTemplate().execute(context -> {
            try {
                return joinPoint.proceed(); // 执行你原有RedisConfig配置的操作
            } catch (Throwable e) {
                // 发生异常时触发重试（包括超时异常）
                throw new RuntimeException("Redis操作失败，触发重试", e);
            }
        });
    }
}
