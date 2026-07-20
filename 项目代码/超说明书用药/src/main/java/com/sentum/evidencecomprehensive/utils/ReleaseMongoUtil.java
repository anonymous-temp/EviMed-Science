package com.sentum.evidencecomprehensive.utils;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * @author zgm
 */
@Component
public class ReleaseMongoUtil {
    public static MongoTemplate mongo;
    @Value("${mongo.dataName}")
    private String uri;
    @PostConstruct
    public void getMongoTemplate(){
        mongo = new MongoTemplate(new SimpleMongoClientDatabaseFactory(uri));
    }
}
