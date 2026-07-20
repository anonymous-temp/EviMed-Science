package com.sentum.util;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * @author zgm
 */
@Component
public class MongoUtil {
    @Autowired
    private MongoTemplate mongoTemplate;
    public static MongoTemplate mongo;
    @PostConstruct
    public void getMongoTemplate(){
        mongo = this.mongoTemplate;
    }
}
