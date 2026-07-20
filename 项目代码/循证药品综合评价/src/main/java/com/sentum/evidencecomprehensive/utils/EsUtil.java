package com.sentum.evidencecomprehensive.utils;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * 对外提供elasticsearchRestTemplate
 * @author zgm
 */
@Component
public class EsUtil {
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    public static ElasticsearchRestTemplate es;
    @PostConstruct
    public void getElasticsearchRestTemplate(){
        es = this.elasticsearchRestTemplate;
    }
}
