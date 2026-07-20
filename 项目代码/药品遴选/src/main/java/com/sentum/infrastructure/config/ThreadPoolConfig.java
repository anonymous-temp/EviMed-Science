package com.sentum.infrastructure.config;

import com.sentum.thread.EviMedThreadFactory;
import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * @Description:
 */
@Configuration
@EnableAsync
public class ThreadPoolConfig implements AsyncConfigurer {

    public static final String SU_THREAD_POOL_NAME = "EviMedThreadPool_SuAnalysis";
    public static final String GUIDE_ANALYSIS_THREAD_POOL_NAME = "EviMedThreadPool_GuideAnalysis";
    public static final String MAIN_GPTANALYSIS_THREAD_POOL_NAME = "EviMedThreadPool_GPTAnalysis";
    
    @Override
    public Executor getAsyncExecutor() {
        return evimedThreadPool();
    }
    
    @Bean(SU_THREAD_POOL_NAME)
    @Primary
    public ThreadPoolTaskExecutor evimedThreadPool() {
        ThreadPoolTaskExecutor threadPoolTaskExecutor = new ThreadPoolTaskExecutor();
        threadPoolTaskExecutor.setWaitForTasksToCompleteOnShutdown(true); // 优雅关机
        threadPoolTaskExecutor.setCorePoolSize(50);
        threadPoolTaskExecutor.setMaxPoolSize(50);
        threadPoolTaskExecutor.setQueueCapacity(77);
        threadPoolTaskExecutor.setThreadNamePrefix("suAnalysis-app-");
        threadPoolTaskExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        threadPoolTaskExecutor.setThreadFactory(new EviMedThreadFactory(threadPoolTaskExecutor));
        threadPoolTaskExecutor.initialize();
        return threadPoolTaskExecutor;
    }

    /**
     * 指南分析 所用线程资源
     * @return
     */
    @Bean(GUIDE_ANALYSIS_THREAD_POOL_NAME)
    public ThreadPoolTaskExecutor guideAnalysisThreadPool() {
        ThreadPoolTaskExecutor threadPoolTaskExecutor = new ThreadPoolTaskExecutor();
        threadPoolTaskExecutor.setWaitForTasksToCompleteOnShutdown(true); // 优雅关机
        threadPoolTaskExecutor.setCorePoolSize(50);
        threadPoolTaskExecutor.setMaxPoolSize(50);
        threadPoolTaskExecutor.setQueueCapacity(140);
        threadPoolTaskExecutor.setThreadNamePrefix("guide-analysis-");
        threadPoolTaskExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        threadPoolTaskExecutor.setThreadFactory(new EviMedThreadFactory(threadPoolTaskExecutor));
        threadPoolTaskExecutor.initialize();
        return threadPoolTaskExecutor;
    }

    /**
     * 询问gpt 所用线程资源 除了指南分析的
     * @return
     */
    @Bean(MAIN_GPTANALYSIS_THREAD_POOL_NAME)
    public ThreadPoolTaskExecutor gptAnalysisThreadPool() {
        ThreadPoolTaskExecutor threadPoolTaskExecutor = new ThreadPoolTaskExecutor();
        threadPoolTaskExecutor.setWaitForTasksToCompleteOnShutdown(true); // 优雅关机
        threadPoolTaskExecutor.setCorePoolSize(20);
        threadPoolTaskExecutor.setMaxPoolSize(30);
        threadPoolTaskExecutor.setQueueCapacity(50);
        threadPoolTaskExecutor.setThreadNamePrefix("gpt-analysis-");
        threadPoolTaskExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        threadPoolTaskExecutor.setThreadFactory(new EviMedThreadFactory(threadPoolTaskExecutor));
        threadPoolTaskExecutor.initialize();
        return threadPoolTaskExecutor;
    }
}
