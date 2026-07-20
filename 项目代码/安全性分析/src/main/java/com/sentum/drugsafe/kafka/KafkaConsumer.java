package com.sentum.drugsafe.kafka;


import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;

/**
 * kafka监听
 *
 * @author sun
 */
@Slf4j
@Component
@EnableKafka
public class KafkaConsumer {

    @Autowired
    RedisTemplate redisTemplate;


    @Autowired
    MongoTemplate mongoTemplate;


//    @KafkaListener(topics = "ScreenFaersData2", groupId = "1")
    public void sendVerifyCode(String msg) {
        JSONObject jsonObject = JSONObject.parseObject(msg);
        log.info("收到反馈：{}",msg);
        this.redisTemplate.opsForValue().set("query_fda_query_prefix"+jsonObject.getString("SearchID"),msg,1, TimeUnit.HOURS);
    }
}