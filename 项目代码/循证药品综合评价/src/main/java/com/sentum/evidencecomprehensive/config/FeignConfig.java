package com.sentum.evidencecomprehensive.config;

import feign.Logger;
import feign.Request;
import feign.Retryer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Description:
 * DateTime: 2024/4/16
 */
@Configuration
public class FeignConfig
{
    @Bean
    Logger.Level feignLoggerLevel()
    {
        return Logger.Level.FULL;
    }

    @Bean
    public Retryer feignRetryer() {
        // 参数：初始间隔(ms), 最大间隔(ms), 最大重试次数（含首次请求）
        return new Retryer.Default(100, 1000, 3);
    }

    @Bean
    public Request.Options options() {
        return new Request.Options(300000, 300000);
    }
}
