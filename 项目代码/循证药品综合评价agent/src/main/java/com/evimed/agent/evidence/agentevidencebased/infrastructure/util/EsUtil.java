package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import jakarta.annotation.PostConstruct;
import org.elasticsearch.client.RestHighLevelClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * 对外提供elasticsearchRestTemplate
 * @author zgm
 */
@Component
public class EsUtil {

    @Autowired
    private RestHighLevelClient restHighLevelClient;
    public static RestHighLevelClient esClient;

    @PostConstruct
    public void getElasticsearchRestTemplate() {
        esClient = this.restHighLevelClient;
    }
}
