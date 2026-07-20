package com.sentum.drugsafe.config;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Pointcut;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.stereotype.Component;

@Aspect
@Component
public class EsOperationAspect {
    @Autowired
    @Qualifier("esRetryTemplate")
    private RetryTemplate esRetryTemplate;

    @Pointcut("execution(* org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate.*(..)) || " +
            "execution(* org.springframework.data.elasticsearch.core.ElasticsearchOperations+.*(..)) || " +
            "execution(* org.springframework.data.elasticsearch.core.IndexOperations+.*(..))")
    public void esOperationPointcut() {}

    @Around("esOperationPointcut()")
    public Object aroundEsOperation(ProceedingJoinPoint joinPoint) throws Throwable {
        return esRetryTemplate.execute(context -> {
            try {
                return joinPoint.proceed();
            } catch (Throwable throwable) {
                throw new RuntimeException("ES操作失败: " + joinPoint.getSignature().toShortString(), throwable);
            }
        });
    }
}