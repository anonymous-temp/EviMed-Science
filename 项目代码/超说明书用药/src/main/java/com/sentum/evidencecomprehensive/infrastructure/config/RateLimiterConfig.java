package com.sentum.evidencecomprehensive.infrastructure.config;

import com.sentum.evidencecomprehensive.service.handler.PriorityKeyBasedRateLimiter;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;

import javax.annotation.PostConstruct;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/10/28
 */
//@Configuration
public class RateLimiterConfig {

//    @Value("${ai.rate.limiter.interval:1000}") // 默认1秒
//    private final long requestInterval = 300;
//
//    @Autowired
//    private PriorityKeyBasedRateLimiter rateLimiter;
//
//    @PostConstruct
//    public void init() {
//        rateLimiter.setRequestInterval(requestInterval);
//    }
}
