package com.sentum.evidencecomprehensive.aspect;

import lombok.extern.slf4j.Slf4j;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Pointcut;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;

@Aspect
@Component
public class EsOperationAspect {
    private static final Logger log = LoggerFactory.getLogger(EsOperationAspect.class);

    // 注入自定义的ES重试模板
    @Autowired
    @Qualifier("esRetryTemplate")
    private RetryTemplate esRetryTemplate;

    // 定义切入点：拦截所有涉及Elasticsearch操作的方法
    // 可根据实际包路径调整（例如service层中包含es操作的方法）
    @Pointcut("execution(* com.sentum.evidencecomprehensive.service..*Service.*(..)) && " +
            "(args(..) && @annotation(org.springframework.data.elasticsearch.annotations.Query) || " +
            "execution(* org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate.*(..)))")
    public void esOperationPointcut() {}

    // 环绕通知：对ES操作应用重试和超时控制
    @Around("esOperationPointcut()")
    public Object aroundEsOperation(ProceedingJoinPoint joinPoint) throws Throwable {
        //
        return esRetryTemplate.execute(context -> {
            // 首次尝试或重试时执行
            log.info("执行ES操作，方法：{}，重试次数：{}",
                    joinPoint.getSignature().getName(),
                    context.getRetryCount());

            // 执行目标方法，并设置20秒超时
            return executeWithTimeout(joinPoint, 20, TimeUnit.SECONDS);
        });
    }

    /**
     * 带超时控制的方法执行
     */
    private Object executeWithTimeout(ProceedingJoinPoint joinPoint, long timeout, TimeUnit unit) throws Throwable {
        // 使用线程池执行，避免阻塞主线程
        return java.util.concurrent.Executors.newSingleThreadExecutor().submit(() -> {
            try {
                return joinPoint.proceed(); // 执行原始方法
            } catch (Throwable e) {
                log.error("ES操作执行失败，方法：{}", joinPoint.getSignature().getName(), e);
                try {
                    throw e; // 抛出异常触发重试
                } catch (Throwable ex) {
                    throw new RuntimeException(ex);
                }
            }
        }).get(timeout, unit); // 超时控制
    }
}
