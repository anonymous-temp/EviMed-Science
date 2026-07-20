package com.sentum.drugsafe.utils;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.enums.ConfigEnum;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.util.concurrent.TimeUnit;


@Service
public class ConfigUtil {

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private RedisTemplate redisTemplate;
    public  String getConfig(ConfigEnum configEnum) {
        String type = configEnum.getType();
        String o = (String)redisTemplate.opsForValue().get("Config:"+type);
      if (StringUtils.isNotEmpty(o)){
          return o;
      }else {
          JSONObject config = mongoTemplate.findOne(new Query(Criteria.where("type").is(type)), JSONObject.class, "config");
          if (ObjectUtils.isNotEmpty(config)){
              String memo = config.getString("value");
              redisTemplate.opsForValue().set("Config:"+type,memo, 60, TimeUnit.MINUTES);
              return memo;
          }else {
              return ConfigEnum.getByType(type).getMemo();
          }
      }
    }
}
