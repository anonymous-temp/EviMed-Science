package com.sentum.evidencecomprehensive.utils;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * @author zgm
 * redis工具类
 */
@Component
public class RedisUtil {
    @Autowired
    private RedisTemplate<String,Object> redisTemplate;
    @Autowired
    private StringRedisTemplate stringRedisTemplate;
    public static RedisTemplate<String,Object> redis;
    public static StringRedisTemplate stringRedis;
    @PostConstruct
    public void getRedisTemplate(){
        redis=this.redisTemplate;
        stringRedis=this.stringRedisTemplate;
    }
}
